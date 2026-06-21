import { log } from "../logger.js";
import { getDbInstance, enqueue } from "./queue.js";

const EMOJI_POOL = ["😊", "😉", "💙", "🎉", "✨", "👍", "🙌", "💪", "🤩", "😍", "🥰", "😎", "🌟", "💫", "🔥", "❤️", "🩵", "💚", "🧡", "💜"];

const CAMPAIGN_STATES = Object.freeze({
  DRAFT: "draft",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

let campaignTablesInitialized = false;

function _getDb() {
  const d = getDbInstance();
  if (!d) throw new Error("Banco de dados nao inicializado");
  return d;
}

function _initCampaignTables() {
  if (campaignTablesInitialized) return;
  const d = getDbInstance();
  if (!d) return;
  try {
    d.run(`
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
    d.run(`
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
    d.run("CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign ON campaign_sends(campaign_id)");
    d.run("CREATE INDEX IF NOT EXISTS idx_campaign_sends_status ON campaign_sends(status)");
    campaignTablesInitialized = true;
    log.info("[campaign] Tabelas inicializadas");
  } catch (err) {
    log.error("[campaign] Erro ao criar tabelas", { error: err.message });
  }
}

function nowISO() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function renderVariables(template, variables = {}) {
  let result = template;
  const h = new Date().getHours();
  const m = new Date().getMinutes();
  const saudacao = h >= 6 && h < 12 ? "Bom dia" : h >= 12 && h < 18 ? "Boa tarde" : "Boa noite";
  const emoji = EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)];

  result = result.replace(/\{saudacao\}/g, saudacao);
  result = result.replace(/\{primeiro_nome\}/g, variables.primeiro_nome || "");
  result = result.replace(/\{nome_completo\}/g, variables.nome_completo || "");
  result = result.replace(/\{nome\}/g, variables.nome_completo || variables.primeiro_nome || "");
  result = result.replace(/\{hora\}/g, String(h).padStart(2, "0"));
  result = result.replace(/\{minuto\}/g, String(m).padStart(2, "0"));
  result = result.replace(/\{emoji\}/g, emoji);
  result = result.replace(/\{cpf_mascarado\}/g, variables.cpf_mascarado || "");
  result = result.replace(/\{cpf\}/g, variables.cpf || "");
  result = result.replace(/\{telefone\}/g, variables.telefone || "");

  return result.trim();
}

function maskCPF(cpf) {
  const digits = String(cpf).replace(/\D/g, "");
  if (digits.length !== 11) return "***.***.***-**";
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

function extractFirstName(fullName) {
  if (!fullName) return "";
  return fullName.split(" ")[0] || "";
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function dbExecOneRow(query, params = []) {
  const d = _getDb();
  const rows = d.exec(query, params);
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const vals = rows[0].values[0];
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
  return obj;
}

function dbExecAllRows(query, params = []) {
  const d = _getDb();
  const rows = d.exec(query, params);
  if (!rows.length || !rows[0].values.length) return [];
  const cols = rows[0].columns;
  return rows[0].values.map((vals) => {
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
    return obj;
  });
}

class CampaignManager {
  constructor() {
    this._campaignTimers = new Map();
    this._activeCampaigns = new Map();
  }

  ensureTables() {
    _initCampaignTables();
  }

  async createCampaign({ name, messages, numbers, delayMin, delayMax }) {
    _initCampaignTables();
    const d = _getDb();
    if (!name || !messages?.length || !numbers?.length) {
      throw new Error("Nome, mensagens e numeros sao obrigatorios");
    }
    if (numbers.length > 100) {
      throw new Error("Limite de 100 numeros por campanha");
    }
    if (messages.length > 5) {
      throw new Error("Limite de 5 modelos de mensagem");
    }

    const ts = nowISO();
    const result = d.exec(
      `INSERT INTO campaigns (name, status, messages, numbers, delay_min, delay_max, total_numbers, pending_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        name,
        CAMPAIGN_STATES.DRAFT,
        JSON.stringify(messages),
        JSON.stringify(numbers),
        delayMin || 180,
        delayMax || 300,
        numbers.length,
        numbers.length,
        ts,
        ts,
      ]
    );
    const campaignId = result[0]?.values[0][0];

    for (let i = 0; i < numbers.length; i++) {
      d.run(
        `INSERT INTO campaign_sends (campaign_id, phone, message_index, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
        [campaignId, numbers[i], i % messages.length, ts]
      );
    }

    log.info("[campaign] Campanha criada", { id: campaignId, name, numbers: numbers.length, messages: messages.length });
    return this.getCampaign(campaignId);
  }

  async getCampaign(id) {
    _initCampaignTables();
    const obj = dbExecOneRow("SELECT * FROM campaigns WHERE id = ?", [id]);
    if (!obj) return null;
    obj.messages = parseJSON(obj.messages, []);
    obj.numbers = parseJSON(obj.numbers, []);
    return obj;
  }

  async listCampaigns(limit = 50, offset = 0) {
    _initCampaignTables();
    const rows = dbExecAllRows("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset]);
    return rows.map((obj) => {
      obj.messages = parseJSON(obj.messages, []);
      obj.numbers = parseJSON(obj.numbers, []);
      return obj;
    });
  }

  async getCampaignSends(campaignId, status, limit = 100) {
    _initCampaignTables();
    let query = "SELECT * FROM campaign_sends WHERE campaign_id = ?";
    const params = [campaignId];
    if (status && status !== "all") {
      query += " AND status = ?";
      params.push(status);
    }
    query += " ORDER BY id ASC LIMIT ?";
    params.push(limit);
    return dbExecAllRows(query, params);
  }

  async startCampaign(id, whatsappService) {
    _initCampaignTables();
    const d = _getDb();
    const campaign = await this.getCampaign(id);
    if (!campaign) throw new Error("Campanha nao encontrada");
    if (campaign.status === CAMPAIGN_STATES.RUNNING) throw new Error("Campanha ja esta em execucao");

    const ts = nowISO();
    d.run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", [CAMPAIGN_STATES.RUNNING, ts, id]);

    log.info("[campaign] Campanha iniciada", { id, name: campaign.name });

    this._processCampaign(id, campaign, whatsappService);
    return this.getCampaign(id);
  }

  async pauseCampaign(id) {
    _initCampaignTables();
    const d = _getDb();
    const campaign = await this.getCampaign(id);
    if (!campaign) throw new Error("Campanha nao encontrada");

    const timer = this._campaignTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._campaignTimers.delete(id);
    }
    this._activeCampaigns.delete(id);

    const ts = nowISO();
    d.run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", [CAMPAIGN_STATES.PAUSED, ts, id]);

    log.info("[campaign] Campanha pausada", { id });
    return this.getCampaign(id);
  }

  async cancelCampaign(id) {
    _initCampaignTables();
    const d = _getDb();
    const campaign = await this.getCampaign(id);
    if (!campaign) throw new Error("Campanha nao encontrada");

    const timer = this._campaignTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._campaignTimers.delete(id);
    }
    this._activeCampaigns.delete(id);

    const ts = nowISO();
    d.run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", [CAMPAIGN_STATES.CANCELLED, ts, id]);
    d.run("UPDATE campaign_sends SET status = 'cancelled' WHERE campaign_id = ? AND status = 'pending'", [id]);

    log.info("[campaign] Campanha cancelada", { id });
    return this.getCampaign(id);
  }

  async _processCampaign(id, campaign, whatsappService) {
    if (!this._activeCampaigns.has(id)) {
      this._activeCampaigns.set(id, { whatsappService, startTime: Date.now() });
    }

    const pendingSends = await this.getCampaignSends(id, "pending");
    if (!pendingSends.length) {
      const d = _getDb();
      const ts = nowISO();
      d.run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", [CAMPAIGN_STATES.COMPLETED, ts, id]);
      this._activeCampaigns.delete(id);
      this._campaignTimers.delete(id);
      log.info("[campaign] Campanha concluida", { id, name: campaign.name });
      return;
    }

    const send = pendingSends[0];
    const messages = campaign.messages || [];
    const messageTemplate = messages[send.message_index % messages.length] || messages[0] || "";
    const phoneDigits = String(send.phone).replace(/\D/g, "");
    const variables = {
      primeiro_nome: "",
      nome_completo: "",
      cpf_mascarado: "",
      cpf: "",
      telefone: phoneDigits,
    };
    const renderedMessage = renderVariables(messageTemplate, variables);

    try {
      const accounts = whatsappService.getAccounts?.() || [];
      const connectedAccount = accounts.find((a) => a.state === "connected");
      if (!connectedAccount) {
        log.warn("[campaign] Nenhuma conta conectada, aguardando...", { campaignId: id });
        this._scheduleNext(id, campaign, whatsappService, 30000);
        return;
      }

      await whatsappService.sendMessageToQueue(phoneDigits, renderedMessage, { campaignId: id, campaignSendId: send.id });

      const d = _getDb();
      const ts = nowISO();
      d.run("UPDATE campaign_sends SET status = 'queued', message_sent = ?, sent_at = ? WHERE id = ?", [renderedMessage, ts, send.id]);
      d.run("UPDATE campaigns SET sent_count = sent_count + 1, pending_count = pending_count - 1, last_sent_at = ?, updated_at = ? WHERE id = ?", [ts, ts, id]);

      log.info("[campaign] Mensagem enfileirada", { campaignId: id, phone: phoneDigits.slice(-8), sendId: send.id });

      const delayMs = randomDelay(campaign.delay_min * 1000, campaign.delay_max * 1000);
      this._scheduleNext(id, campaign, whatsappService, delayMs);
    } catch (err) {
      const d = _getDb();
      const ts = nowISO();
      d.run("UPDATE campaign_sends SET status = 'error', error = ?, sent_at = ? WHERE id = ?", [String(err.message).slice(0, 500), ts, send.id]);
      d.run("UPDATE campaigns SET error_count = error_count + 1, pending_count = pending_count - 1, updated_at = ? WHERE id = ?", [ts, id]);

      log.error("[campaign] Erro ao processar envio", { campaignId: id, error: err.message });
      this._scheduleNext(id, campaign, whatsappService, 10000);
    }
  }

  _scheduleNext(id, campaign, whatsappService, delayMs) {
    const existing = this._campaignTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this._campaignTimers.delete(id);
      try {
        const current = await this.getCampaign(id);
        if (current && current.status === CAMPAIGN_STATES.RUNNING) {
          this._processCampaign(id, current, whatsappService);
        }
      } catch (err) {
        log.error("[campaign] Erro no timer agendado", { campaignId: id, error: err.message });
      }
    }, delayMs);
    this._campaignTimers.set(id, timer);
  }

  async getStats(id) {
    _initCampaignTables();
    const campaign = await this.getCampaign(id);
    if (!campaign) return null;

    const d = _getDb();
    const rows = d.exec(
      "SELECT status, COUNT(*) as count FROM campaign_sends WHERE campaign_id = ? GROUP BY status",
      [id]
    );
    const stats = { queued: 0, pending: 0, sent: 0, error: 0, cancelled: 0, total: campaign.total_numbers };
    if (rows.length) {
      for (const [status, count] of rows[0].values) {
        stats[status] = count;
      }
    }
    stats.sent = stats.queued + stats.sent;
    stats.delivered = stats.sent;

    if (campaign.status === CAMPAIGN_STATES.RUNNING && stats.pending > 0) {
      const avgDelay = (campaign.delay_min + campaign.delay_max) / 2;
      const estimatedSeconds = stats.pending * avgDelay;
      const hours = Math.floor(estimatedSeconds / 3600);
      const minutes = Math.floor((estimatedSeconds % 3600) / 60);
      stats.estimatedCompletion = hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;
    } else {
      stats.estimatedCompletion = campaign.estimated_completion || null;
    }

    return stats;
  }

  async renderPreview(template, variables = {}) {
    return renderVariables(template, variables);
  }
}

export const campaignManager = new CampaignManager();
export { CAMPAIGN_STATES, EMOJI_POOL, renderVariables, maskCPF };
