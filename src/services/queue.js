import initSqlJs from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";
import { config } from "../config.js";

const DB_PATH = config.sessionFolder.replace("/session", "") + "/queue.db";

let db = null;
let SQL = null;
let _dequeueLock = Promise.resolve();
let _saveTimer = null;
let _dirty = false;

async function getDb() {
  if (db) return db;
  const dataDir = config.sessionFolder.replace("/session", "");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      completed_at TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_queue_status ON message_queue(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_queue_priority ON message_queue(priority, created_at)");
  try { db.run("ALTER TABLE message_queue ADD COLUMN account INTEGER"); } catch {}
  db.run("CREATE INDEX IF NOT EXISTS idx_queue_account ON message_queue(account)");
  _save(true);
  _initCampaignTables(db);
  _recoverOrphanedMessages(db);
  return db;
}

function _recoverOrphanedMessages(database) {
  try {
    const result = database.exec("SELECT COUNT(*) FROM message_queue WHERE status = 'processing'");
    const count = result[0]?.values[0][0] || 0;
    if (count > 0) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      database.run("UPDATE message_queue SET status = 'pending', account = NULL, last_error = 'orphan_recovery', updated_at = ? WHERE status = 'processing'", [ts]);
      _save(true);
      log.info("[queue] Mensagens orphaned recuperadas", { count });
    }
  } catch (err) {
    log.error("[queue] Erro ao recuperar mensagens orphaned", { error: err.message });
  }
}

function _initCampaignTables(database) {
  try {
    database.run(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        messages TEXT NOT NULL DEFAULT '[]',
        numbers TEXT NOT NULL DEFAULT '[]',
        delay_min INTEGER NOT NULL DEFAULT 180,
        delay_max INTEGER NOT NULL DEFAULT 300,
        total_numbers INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        pending_count INTEGER NOT NULL DEFAULT 0,
        last_sent_at TEXT,
        estimated_completion TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS campaign_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        message_sent TEXT,
        message_index INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
      )
    `);
    database.run("CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign ON campaign_sends(campaign_id)");
    database.run("CREATE INDEX IF NOT EXISTS idx_campaign_sends_status ON campaign_sends(status)");
    log.info("[queue] Tabelas de campanha inicializadas");
  } catch (err) {
    log.error("[queue] Erro ao criar tabelas de campanha", { error: err.message });
  }
}

function _save(immediate = false) {
  if (!db) return;
  _dirty = true;
  if (immediate) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    const data = db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
    return;
  }
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty || !db) return;
    const data = db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
    _dirty = false;
  }, 2000);
}

export function flushSave() {
  _save(true);
}

function nowISO() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export async function enqueue(phone, message, metadata = {}) {
  const d = await getDb();
  const ts = nowISO();
  const result = d.exec(
    "INSERT INTO message_queue (phone, message, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    [phone, message, JSON.stringify(metadata), ts, ts]
  );
  _save();
  const id = result[0]?.values[0][0];
  log.info("[queue] Enfileirado", { id, phone: phone.slice(-8) });
  return id;
}

export async function dequeue(limit = 1, account) {
  const result = _dequeueLock.then(() => _doDequeue(limit, account));
  _dequeueLock = result.catch(() => {});
  return result;
}

async function _doDequeue(limit = 1, account) {
  const d = await getDb();
  const ts = nowISO();
  const rows = d.exec(
    `SELECT id, phone, message, metadata, retry_count, max_retries, created_at
     FROM message_queue
     WHERE status = 'pending' ${account !== undefined ? "AND (account IS NULL OR account = ?)" : ""}
     ORDER BY priority DESC, created_at ASC
     LIMIT ?`,
    account !== undefined ? [account, limit] : [limit]
  );
  if (!rows.length || !rows[0].values.length) return [];
  const items = rows[0].values.map((row) => ({
    id: row[0],
    phone: row[1],
    message: row[2],
    metadata: tryParse(row[3], {}),
    retry_count: row[4],
    max_retries: row[5],
    created_at: row[6],
  }));
  const ids = items.map((r) => r.id);
  d.run(`UPDATE message_queue SET status = 'processing', account = ?, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`, [account ?? -1, ts, ...ids]);
  _save();
  return items;
}

export async function reassignByAccount(fromAccount) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'pending', account = NULL, last_error = 'reassign', updated_at = ? WHERE status = 'processing' AND account = ?", [ts, fromAccount]);
  const count = d.getRowsModified();
  if (count > 0) log.warn("[queue] Reatribuído", { fromAccount, count });
  return count;
}

export async function complete(id) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [ts, ts, id]);
  _save();
  log.info("[queue] Completado", { id });
  return true;
}

export async function fail(id, error) {
  const d = await getDb();
  const ts = nowISO();
  const row = d.exec("SELECT retry_count, max_retries FROM message_queue WHERE id = ?", [id]);
  if (!row.length || !row[0].values.length) return false;
  const retryCount = row[0].values[0][0] + 1;
  const maxRetries = row[0].values[0][1];
  if (retryCount >= maxRetries) {
    d.run("UPDATE message_queue SET status = 'deadletter', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?", [retryCount, String(error).slice(0, 500), ts, id]);
    log.warn("[queue] Dead letter", { id, error: String(error).slice(0, 200), retries: retryCount });
  } else {
    d.run("UPDATE message_queue SET status = 'pending', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?", [retryCount, String(error).slice(0, 500), ts, id]);
    log.warn("[queue] Falhou (retry pendente)", { id, error: String(error).slice(0, 200), retry: retryCount, max: maxRetries });
  }
  _save();
  return true;
}

export async function revertToPending(id, errorMsg) {
  const d = await getDb();
  const ts = nowISO();
  d.run(
    "UPDATE message_queue SET status = 'pending', account = NULL, last_error = ?, created_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'",
    [errorMsg || null, ts, ts, id]
  );
  _save();
  return true;
}

export async function retry(id) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','deadletter')", [ts, id]);
  _save();
  log.info("[queue] Reenfileirado manualmente", { id });
  return true;
}

export async function retryAll() {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'pending', retry_count = 0, last_error = NULL, updated_at = ? WHERE status IN ('failed','deadletter')", [ts]);
  _save();
  const changes = d.getRowsModified();
  if (changes > 0) log.info("[queue] Todos reenfileirados", { count: changes });
  return changes;
}

export async function stats() {
  const d = await getDb();
  const rows = d.exec("SELECT status, COUNT(*) as count FROM message_queue GROUP BY status");
  const result = { pending: 0, processing: 0, completed: 0, failed: 0, deadletter: 0, total: 0 };
  if (rows.length) {
    for (const row of rows[0].values) {
      result[row[0]] = row[1];
    }
  }
  result.total = result.pending + result.processing + result.completed + result.failed + result.deadletter;
  return result;
}

export async function list(status, limit = 50, offset = 0) {
  const d = await getDb();
  if (status && status !== "all") {
    const rows = d.exec("SELECT * FROM message_queue WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [status, limit, offset]);
    return _rowsToObjects(rows, ["id", "phone", "message", "status", "priority", "retry_count", "max_retries", "last_error", "metadata", "created_at", "updated_at", "completed_at"]);
  }
  const rows = d.exec("SELECT * FROM message_queue ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset]);
  return _rowsToObjects(rows, ["id", "phone", "message", "status", "priority", "retry_count", "max_retries", "last_error", "metadata", "created_at", "updated_at", "completed_at"]);
}

export async function pendingCount() {
  const d = await getDb();
  const rows = d.exec("SELECT COUNT(*) as count FROM message_queue WHERE status = 'pending'");
  return rows.length && rows[0].values.length ? rows[0].values[0][0] : 0;
}

export async function deadletter(id, error) {
  const d = await getDb();
  const ts = nowISO();
  d.run("UPDATE message_queue SET status = 'deadletter', last_error = ?, updated_at = ? WHERE id = ?", [String(error).slice(0, 500), ts, id]);
  _save();
  log.warn("[queue] Dead letter direto (sem retry)", { id, error: String(error).slice(0, 200) });
  return true;
}

export async function clearCompleted() {
  const d = await getDb();
  d.run("DELETE FROM message_queue WHERE status = 'completed'");
  _save();
  const changes = d.getRowsModified();
  if (changes > 0) log.info("[queue] Limpos completados", { deleted: changes });
  return changes;
}

export async function clearAll(status) {
  const d = await getDb();
  if (status) {
    d.run("DELETE FROM message_queue WHERE status = ?", [status]);
  } else {
    d.run("DELETE FROM message_queue");
  }
  _save();
  return d.getRowsModified();
}

export function closeDb() {
  if (db) {
    _save(true);
    db.close();
    db = null;
    log.info("[queue] Banco fechado");
  }
}

export function getDbInstance() {
  return db;
}

function _rowsToObjects(rows, columns) {
  if (!rows.length || !rows[0].values.length) return [];
  return rows[0].values.map((row) => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
    return obj;
  });
}

function tryParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}
