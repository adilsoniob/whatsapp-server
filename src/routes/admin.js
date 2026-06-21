import { Router } from "express";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getStealthConfig, setStealthEnabled } from "../services/stealth/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "../../data");
const WHATSAPP_MSGS_FILE = join(DATA_DIR, "whatsapp-messages.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadWAMessages() {
  ensureDataDir();
  if (!existsSync(WHATSAPP_MSGS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WHATSAPP_MSGS_FILE, "utf8"));
  } catch { return []; }
}

function saveWAMessages(msgs) {
  ensureDataDir();
  writeFileSync(WHATSAPP_MSGS_FILE, JSON.stringify(msgs, null, 2));
}

let _nextMsgId = null;
function getNextMsgId(msgs) {
  if (_nextMsgId === null) {
    _nextMsgId = msgs.reduce((max, m) => Math.max(max, m.id || 0), 0) + 1;
  }
  return _nextMsgId++;
}

export function createAdminRouter(whatsapp, authMiddleware) {
  const router = Router();
  const storage = whatsapp.storage;

  if (authMiddleware) {
    // Aplica auth SOMENTE nas rotas /api/admin/* — a pagina /admin fica publica
    router.use("/api/admin", authMiddleware);
  }

  // ---- Status ----

  router.get("/api/admin/status", (_req, res) => {
    const primary = whatsapp.getStatus();
    res.json({ success: true, ...primary, accounts: whatsapp.getAccounts() });
  });

  // ---- Messages ----

  router.get("/api/admin/messages", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const filters = {};
    if (req.query.account !== undefined) filters.account = parseInt(req.query.account, 10);
    if (req.query.status) filters.status = req.query.status;
    if (req.query.phone) filters.phone = req.query.phone;
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;
    const messages = storage?.getMessages(limit, filters) || [];
    res.json({ success: true, messages, total: messages.length, filters });
  });

  router.get("/api/admin/messages/stats", (_req, res) => {
    const stats = storage?.getMessageStatsByPeriod() || {};
    res.json({ success: true, stats });
  });

  router.get("/api/admin/messages/:phone", (req, res) => {
    const phone = req.params.phone;
    const messages = storage?.getMessagesByPhone(phone) || [];
    res.json({ success: true, messages });
  });

  // ---- Contacts ----

  router.get("/api/admin/contacts", (_req, res) => {
    const contacts = storage?.getContacts() || [];
    res.json({ success: true, contacts });
  });

  // ---- Logs ----

  router.get("/api/admin/logs", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const filters = {};
    if (req.query.account !== undefined) filters.account = parseInt(req.query.account, 10);
    if (req.query.event) filters.event = req.query.event;
    if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo) filters.dateTo = req.query.dateTo;
    const logs = storage?.getLogs(limit, filters) || [];
    res.json({ success: true, logs, total: logs.length, filters });
  });

  // ---- Stats ----

  router.get("/api/admin/stats", (_req, res) => {
    const stats = storage?.getMessageStats() || {};
    res.json({ success: true, stats });
  });

  // ---- Stealth (anti-ban) ----

  router.get("/api/admin/stealth", (_req, res) => {
    res.json({ success: true, config: getStealthConfig() });
  });

  router.post("/api/admin/stealth", (req, res) => {
    const enabled = req.body?.enabled === true;
    setStealthEnabled(enabled);
    res.json({ success: true, enabled });
  });

  // ---- Templates ----

  router.get("/api/admin/templates", (_req, res) => {
    const templates = loadTemplates();
    res.json({ success: true, templates });
  });

  router.get("/api/admin/templates/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const templates = loadTemplates();
    const template = templates.find((t) => t.id === id);
    if (!template) return res.status(404).json({ success: false, error: "Template não encontrado" });
    res.json({ success: true, template });
  });

  router.post("/api/admin/templates", (req, res) => {
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, error: "Texto obrigatório" });
    const templates = loadTemplates();
    if (templates.length >= 50) return res.status(400).json({ success: false, error: "Máximo de 50 templates" });
    const id = getNextTemplateId(templates);
    templates.push({ id, text, createdAt: new Date().toISOString() });
    saveTemplates(templates);
    res.json({ success: true, message: "Template criado", id });
  });

  router.put("/api/admin/templates/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, error: "Texto obrigatório" });
    const templates = loadTemplates();
    const idx = templates.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Template não encontrado" });
    templates[idx].text = text;
    templates[idx].updatedAt = new Date().toISOString();
    saveTemplates(templates);
    res.json({ success: true, message: "Template atualizado" });
  });

  router.delete("/api/admin/templates/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    let templates = loadTemplates();
    const len = templates.length;
    templates = templates.filter((t) => t.id !== id);
    if (templates.length === len) return res.status(404).json({ success: false, error: "Template não encontrado" });
    saveTemplates(templates);
    res.json({ success: true, message: "Template excluído" });
  });

  // ---- WhatsApp Messages (gerenciamento de mensagens para EdgeOne) ----

  router.get("/api/admin/whatsapp-messages", (_req, res) => {
    const messages = loadWAMessages();
    res.json({ success: true, messages });
  });

  router.get("/api/whatsapp-messages", (_req, res) => {
    const messages = loadWAMessages().filter((m) => m.active);
    res.json({ success: true, messages: messages.map((m) => ({ id: m.id, text: m.text })) });
  });

  router.post("/api/admin/whatsapp-messages", (req, res) => {
    const text = (req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, error: "Texto obrigatório" });
    if (text.length > 1600) return res.status(400).json({ success: false, error: "Máximo 1600 caracteres" });
    const messages = loadWAMessages();
    if (messages.length >= 50) return res.status(400).json({ success: false, error: "Máximo de 50 mensagens" });
    const id = getNextMsgId(messages);
    const active = req.body?.active !== false;
    messages.push({ id, text, active, createdAt: new Date().toISOString() });
    saveWAMessages(messages);
    res.json({ success: true, message: "Mensagem criada", id });
  });

  router.put("/api/admin/whatsapp-messages/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const messages = loadWAMessages();
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Mensagem não encontrada" });
    if (req.body?.text !== undefined) {
      const text = req.body.text.trim();
      if (!text) return res.status(400).json({ success: false, error: "Texto obrigatório" });
      if (text.length > 1600) return res.status(400).json({ success: false, error: "Máximo 1600 caracteres" });
      messages[idx].text = text;
    }
    if (req.body?.active !== undefined) messages[idx].active = !!req.body.active;
    messages[idx].updatedAt = new Date().toISOString();
    saveWAMessages(messages);
    res.json({ success: true, message: "Mensagem atualizada" });
  });

  router.post("/api/admin/whatsapp-messages/:id/toggle", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const messages = loadWAMessages();
    const msg = messages.find((m) => m.id === id);
    if (!msg) return res.status(404).json({ success: false, error: "Mensagem não encontrada" });
    msg.active = !msg.active;
    msg.updatedAt = new Date().toISOString();
    saveWAMessages(messages);
    res.json({ success: true, active: msg.active });
  });

  router.delete("/api/admin/whatsapp-messages/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    let messages = loadWAMessages();
    const len = messages.length;
    messages = messages.filter((m) => m.id !== id);
    if (messages.length === len) return res.status(404).json({ success: false, error: "Mensagem não encontrada" });
    saveWAMessages(messages);
    res.json({ success: true, message: "Mensagem excluída" });
  });

  // ---- Admin HTML ----

  router.get("/admin", (_req, res) => {
    res.type("html").send(ADMIN_HTML);
  });

  return router;
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Server | Painel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0b1120;--card:#151f35;--sidebar:#111b2e;--border:#1e2d4a;--text:#e2e8f0;--muted:#7e8ea8;--accent:#3b82f6;--green:#22c55e;--green-bg:rgba(34,197,94,0.12);--yellow:#eab308;--yellow-bg:rgba(234,179,8,0.12);--red:#ef4444;--red-bg:rgba(239,68,68,0.12);--radius:12px;--radius-sm:8px}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5}
.layout{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
.sidebar{background:var(--sidebar);padding:1.25rem;border-right:1px solid var(--border);overflow-y:auto;position:sticky;top:0;height:100vh}
.sidebar .logo{font-size:1rem;font-weight:700;margin-bottom:1.5rem;display:flex;align-items:center;gap:.5rem}
.sidebar h2{font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:1.25rem 0 .6rem;font-weight:600}
.sidebar .stat{display:flex;justify-content:space-between;padding:.35rem 0;font-size:.78rem}
.sidebar .stat+.stat{border-top:1px solid var(--border)}
.sidebar .stat-label{color:var(--muted)}
.sidebar .stat-value{font-weight:600}
.sidebar-account{display:flex;align-items:center;gap:.35rem;padding:.3rem .4rem;border-radius:6px;font-size:.75rem;color:var(--muted)}
.sidebar-account .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.sidebar-account .name{flex:1}
.main{display:flex;flex-direction:column;height:100vh}
.topbar{display:flex;align-items:center;gap:.65rem;padding:.65rem 1.25rem;background:var(--card);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
.topbar h1{font-size:.9rem;font-weight:600;flex:1}
.uptime{font-size:.7rem;color:var(--muted)}
.status-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.status-dot--connected{background:var(--green);box-shadow:0 0 10px rgba(34,197,94,.35)}
.status-dot--awaiting_qr,.status-dot--reconnecting{background:var(--yellow);box-shadow:0 0 10px rgba(234,179,8,.35)}
.status-dot--offline,.status-dot--auth_failure,.status-dot--error{background:var(--red);box-shadow:0 0 10px rgba(239,68,68,.35)}
.status-dot--starting{background:var(--muted)}
.content{flex:1;overflow-y:auto;padding:1.25rem;display:grid;grid-template-columns:1fr;gap:1rem;align-content:start}
.card{background:var(--card);border-radius:var(--radius);padding:1.1rem;border:1px solid var(--border)}
.card h3{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:.85rem;font-weight:600}
.tag{display:inline-block;padding:.12rem .5rem;border-radius:999px;font-size:.65rem;font-weight:600}
.tag-success{background:var(--green-bg);color:var(--green)}
.tag-warning{background:var(--yellow-bg);color:var(--yellow)}
.tag-error{background:var(--red-bg);color:var(--red)}
.tag-info{background:rgba(96,165,250,0.1);color:#60a5fa}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.3rem;padding:.35rem .8rem;border-radius:var(--radius-sm);border:none;font-size:.73rem;font-weight:600;cursor:pointer;transition:all .15s}
.btn:hover{transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn-primary{background:var(--accent);color:#fff}
.btn-danger{background:var(--red);color:#fff}
.btn-warning{background:var(--yellow);color:#0f172a}
.btn-success{background:var(--green);color:#0f172a}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--muted)}
.btn-outline:hover{border-color:var(--text);color:var(--text)}
.btn-sm{padding:.25rem .55rem;font-size:.68rem}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}
.table-wrap{max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm)}
table{width:100%;border-collapse:collapse;font-size:.75rem}
th{text-align:left;padding:.45rem .5rem;color:var(--muted);font-weight:600;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;background:var(--bg);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:1}
td{padding:.4rem .5rem;border-bottom:1px solid rgba(30,45,74,.4);font-size:.75rem}
tr:hover td{background:rgba(59,130,246,.04)}
.tabs{display:flex;gap:.25rem;margin-bottom:.85rem;flex-wrap:wrap}
.tab{padding:.45rem .9rem;font-size:.75rem;font-weight:600;cursor:pointer;color:var(--muted);border-radius:var(--radius-sm);transition:all .2s}
.tab:hover{background:rgba(59,130,246,.08);color:var(--text)}
.tab.active{background:var(--accent);color:#fff}
.tab-content{display:none;animation:fadeUp .2s ease}
.tab-content.active{display:block}
@keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.filters{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.65rem;align-items:center}
.filters input,.filters select{padding:.3rem .45rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:.72rem;outline:none}
.filters input:focus,.filters select:focus{border-color:var(--accent)}
.filters label{font-size:.7rem;color:var(--muted);display:inline-flex;align-items:center;gap:.3rem}
.empty{color:var(--muted);font-size:.75rem;padding:1.25rem 0;text-align:center}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.65rem}
.kpi{padding:.75rem;border-radius:var(--radius-sm);border:1px solid var(--border);text-align:center}
.kpi .kpi-value{font-size:1.4rem;font-weight:700;letter-spacing:-.03em}
.kpi .kpi-label{font-size:.65rem;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:.05em}
.kpi-green .kpi-value{color:var(--green)}.kpi-yellow .kpi-value{color:var(--yellow)}.kpi-red .kpi-value{color:var(--red)}.kpi-blue .kpi-value{color:var(--accent)}
.accounts-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.85rem;flex-wrap:wrap;gap:.5rem}
.accounts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.7rem}
.account-card{background:var(--bg);border-radius:var(--radius);padding:.85rem;border:1px solid var(--border)}
.account-card .ac-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem}
.account-card .ac-hd .ac-label{font-weight:600;font-size:.82rem}
.account-card .ac-info{font-size:.72rem;color:var(--muted);line-height:1.5}
.account-card .ac-qr{text-align:center;padding:8px 0}
.account-card .ac-qr img{width:140px;height:140px;border-radius:8px;border:1px solid var(--border);background:#fff;padding:5px}
.account-card .ac-qr p{font-size:.62rem;color:var(--muted);margin-top:3px}
.account-card .ac-actions{display:flex;gap:.25rem;flex-wrap:wrap;margin-top:.5rem}
.queue-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.65rem;margin-bottom:.85rem}
.queue-card{padding:.65rem;border-radius:var(--radius-sm);border:1px solid var(--border);text-align:center}
.queue-card .qty{font-size:1.3rem;font-weight:700}
.queue-card .qlabel{font-size:.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.queue-list{max-height:350px;overflow-y:auto}
.qitem{display:flex;align-items:center;gap:.5rem;padding:.35rem .5rem;border-bottom:1px solid rgba(30,45,74,.4);font-size:.72rem}
.qitem:hover{background:rgba(59,130,246,.04)}
.qitem .qphone{font-weight:600;font-family:monospace;min-width:100px;font-size:.75rem}
.qitem .qmsg{color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qitem .qretry{color:var(--muted);min-width:30px;text-align:right;font-size:.65rem}
.int-item{display:flex;justify-content:space-between;align-items:center;padding:.45rem .5rem;border-bottom:1px solid rgba(30,45,74,.4);font-size:.75rem}
.int-item:last-child{border-bottom:none}
.int-item:hover{background:rgba(59,130,246,.04)}
.int-name{font-weight:600}.int-url{color:var(--muted);font-size:.7rem}
.int-meta{text-align:right;font-size:.68rem;color:var(--muted)}
.log-item{display:flex;gap:.5rem;padding:.35rem .5rem;border-bottom:1px solid rgba(30,45,74,.4);font-size:.72rem;align-items:center}
.log-item:last-child{border-bottom:none}
.log-item:hover{background:rgba(59,130,246,.04)}
.log-time{color:var(--muted);flex-shrink:0;font-family:monospace;font-size:.65rem;min-width:130px}
.log-ac{font-weight:600;flex-shrink:0;width:40px;color:var(--accent);font-size:.68rem}
.log-event{font-weight:600;flex-shrink:0;min-width:90px;font-size:.68rem}
.log-desc{color:var(--muted)}
.report-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.65rem;margin-bottom:.85rem}
.report-card{padding:.7rem;border-radius:var(--radius-sm);border:1px solid var(--border);text-align:center}
.report-card .rp-period{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.report-card .rp-total{font-size:1.5rem;font-weight:700;margin:4px 0}
.report-card .rp-detail{font-size:.65rem;color:var(--muted)}
.report-card .rp-detail span{display:inline-block;margin:0 4px}
.contact-item{display:flex;justify-content:space-between;align-items:center;padding:.4rem .5rem;border-bottom:1px solid rgba(30,45,74,.4);font-size:.75rem}
.contact-item:last-child{border-bottom:none}
.contact-item:hover{background:rgba(59,130,246,.04)}
.contact-phone{font-weight:600;font-family:monospace;font-size:.78rem}
.profile-info strong{font-size:.8rem}.profile-info small{display:block;color:var(--muted);font-size:.72rem}
.error-text{color:var(--red);font-size:.72rem}
.toast{position:fixed;bottom:1.25rem;right:1.25rem;z-index:999;display:flex;flex-direction:column;gap:.4rem;pointer-events:none}
.toast-item{padding:.55rem .9rem;border-radius:var(--radius-sm);font-size:.75rem;font-weight:500;pointer-events:auto;animation:slideIn .25s ease;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.toast-success{background:#065f46;color:#a7f3d0;border:1px solid #059669}
.toast-error{background:#7f1d1d;color:#fecaca;border:1px solid #dc2626}
.toast-info{background:#1e3a5f;color:#bfdbfe;border:1px solid #2563eb}
@keyframes slideIn{from{opacity:0;transform:translateX(15px)}to{opacity:1;transform:translateX(0)}}
.modal-overlay{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
.modal-overlay.active{display:flex}
.modal{background:var(--card);border-radius:var(--radius);padding:1.5rem;border:1px solid var(--border);max-width:360px;width:90%;text-align:center}
.modal h3{font-size:.9rem;margin-bottom:.25rem;text-transform:none;letter-spacing:0;color:var(--text)}
.modal p.sub{font-size:.75rem;color:var(--muted);margin-bottom:1rem}
.modal .qr-box{background:var(--bg);border-radius:var(--radius-sm);padding:1rem;border:1px solid var(--border);margin-bottom:.75rem}
.modal .qr-box img{width:200px;height:200px;border-radius:8px;background:#fff;padding:6px}
.modal .qr-timer{font-size:.7rem;color:var(--muted);margin-bottom:.75rem;font-family:monospace}
.modal .modal-actions{display:flex;gap:.5rem;justify-content:center}
@media(max-width:768px){.layout{grid-template-columns:1fr}.sidebar{display:none}.content{padding:.85rem}.kpis{grid-template-columns:repeat(2,1fr)}.accounts-grid{grid-template-columns:1fr}.queue-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div id="loginScreen" style="position:fixed;inset:0;z-index:9999;background:var(--bg);display:none;align-items:center;justify-content:center">
  <div style="background:var(--card);border-radius:var(--radius);padding:2rem;border:1px solid var(--border);max-width:340px;width:90%;text-align:center">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="margin-bottom:1rem"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    <h2 style="font-size:1rem;margin-bottom:.25rem">WhatsApp Server</h2>
    <p style="font-size:.75rem;color:var(--muted);margin-bottom:1rem">Insira a chave de acesso para continuar</p>
    <input id="loginKey" type="password" placeholder="Chave de acesso" style="width:100%;padding:.6rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.85rem;margin-bottom:.75rem;text-align:center">
    <button class="btn btn-primary" style="width:100%" onclick="doLogin()">Entrar</button>
    <p id="loginError" style="font-size:.7rem;color:var(--red);margin-top:.5rem;display:none">Chave invalida</p>
  </div>
</div>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <div class="logo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      WhatsApp Server
    </div>
    <h2>Dashboard</h2>
    <div class="stat"><span class="stat-label">Contas</span><span class="stat-value" id="sTotalAcc">0</span></div>
    <div class="stat"><span class="stat-label">Conectadas</span><span class="stat-value" id="sConnectedAcc">0</span></div>
    <div class="stat"><span class="stat-label">Mensagens (mês)</span><span class="stat-value" id="sMonthMsg">0</span></div>
    <div class="stat"><span class="stat-label">Integrações</span><span class="stat-value" id="sIntegracoes">0</span></div>
    <div class="stat"><span class="stat-label">Fila</span><span class="stat-value" id="sQueuePend">0</span></div>
    <h2>Contas</h2>
    <div id="sidebarAccounts"></div>
    <h2>Ações</h2>
    <div style="display:flex;flex-direction:column;gap:.3rem">
      <button class="btn btn-primary btn-sm" onclick="_addAccount()">+ Adicionar Conta</button>
      <button class="btn btn-outline btn-sm" onclick="_fullRefresh()">Atualizar</button>
    </div>
  </aside>
  <div class="main">
    <div class="topbar">
      <span class="status-dot status-dot--starting" id="topStatusDot"></span>
      <h1 id="topStatusText">Carregando...</h1>
      <span class="uptime" id="topUptime"></span>
      <span class="stealth-toggle" id="stealthToggle" style="margin-left:auto;cursor:pointer;font-size:.72rem;display:flex;align-items:center;gap:6px;user-select:none" onclick="toggleStealth()">
        <span id="stealthLabel">Anti-ban</span>
        <span id="stealthDot" style="width:10px;height:10px;border-radius:50%;background:#999;display:inline-block"></span>
      </span>
    </div>
    <div class="content">
      <div class="card">
        <div class="tabs" id="mainTabs">
          <div class="tab active" data-tab="dashboard">Dashboard</div>
          <div class="tab" data-tab="contas">Contas</div>
          <div class="tab" data-tab="fila">Fila</div>
          <div class="tab" data-tab="mensagens">Mensagens</div>
          <div class="tab" data-tab="templates">Templates</div>
          <div class="tab" data-tab="contatos">Contatos</div>
          <div class="tab" data-tab="logs">Logs</div>
          <div class="tab" data-tab="relatorios">Relatórios</div>
          <div class="tab" data-tab="campanhas">Campanhas</div>
        </div>
        <!-- Dashboard -->
        <div class="tab-content active" id="tabDashboard">
          <div class="kpis" id="kpiGrid"></div>
        </div>
        <!-- Contas -->
        <div class="tab-content" id="tabContas">
          <div class="accounts-header">
            <span style="font-size:.75rem;color:var(--muted)" id="accSummary"></span>
            <button class="btn btn-primary btn-sm" onclick="addAccount()">+ Adicionar Conta</button>
          </div>
          <div class="accounts-grid" id="accountsGrid"></div>
        </div>
        <!-- Fila -->
        <div class="tab-content" id="tabFila">
          <div class="queue-grid" id="queueGrid"></div>
          <div style="display:flex;gap:.3rem;flex-wrap:wrap;margin-bottom:.65rem">
            <button class="btn btn-warning btn-sm" onclick="retryAll()">Reenfileirar Falhas</button>
            <button class="btn btn-outline btn-sm" onclick="clearCompleted()">Limpar Completados</button>
            <button class="btn btn-outline btn-sm" onclick="loadQueue()">Atualizar</button>
            <span style="font-size:.68rem;color:var(--muted);margin-left:auto" id="queueCount"></span>
          </div>
          <div class="queue-list" id="queueList"></div>
        </div>
        <!-- Mensagens -->
        <div class="tab-content" id="tabMensagens">
          <div class="filters">
            <label>Status: <select id="filterMsgStatus"><option value="">Todos</option><option value="sent">Enviado</option><option value="delivered">Entregue</option><option value="failed">Falhou</option></select></label>
            <label>Número: <input id="filterMsgPhone" placeholder="559999999999" style="width:110px"></label>
            <button class="btn btn-primary btn-sm" onclick="loadMessages()">Filtrar</button>
            <span style="font-size:.68rem;color:var(--muted);margin-left:auto" id="msgCount"></span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Data/Hora</th><th>Número</th><th>Status</th><th>Origem</th></tr></thead>
              <tbody id="messagesBody"><tr><td colspan="4" class="empty">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
        <!-- Templates (Mensagens WhatsApp) -->
        <div class="tab-content" id="tabTemplates">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.85rem;flex-wrap:wrap;gap:.5rem">
            <div>
              <h3 style="margin:0;font-size:.9rem">Mensagens WhatsApp (máx. 50)</h3>
              <div style="font-size:.68rem;color:var(--muted);margin-top:2px">Ative as mensagens que devem ser enviadas aleatoriamente pelo EdgeOne</div>
            </div>
            <button class="btn btn-primary btn-sm" onclick="openWAMsgModal()">+ Nova Mensagem</button>
          </div>
          <div style="font-size:.7rem;color:var(--muted);margin-bottom:.6rem">
            Variáveis: <code>{saudacao}</code> <code>{primeiro_nome}</code> <code>{nome}</code> <code>{cpf}</code> <code>{telefone}</code> <code>{link}</code> <code>{link_pagamento}</code> <code>{data}</code> <code>{hora}</code>
          </div>
          <div id="waMsgStats" style="display:flex;gap:.5rem;margin-bottom:.65rem;flex-wrap:wrap"></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th style="width:40px">#</th><th>Mensagem</th><th style="width:70px">Status</th><th style="width:160px">Ações</th></tr></thead>
              <tbody id="waMsgsBody"><tr><td colspan="4" class="empty">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
        <!-- Contatos -->
        <div class="tab-content" id="tabContatos">
          <div id="contactsBody"></div>
        </div>
        <!-- Logs -->
        <div class="tab-content" id="tabLogs">
          <div class="filters">
            <label>Evento: <input id="filterLogEvent" placeholder="connected, message_sent..." style="width:130px"></label>
            <button class="btn btn-primary btn-sm" onclick="loadLogs()">Filtrar</button>
            <span style="font-size:.68rem;color:var(--muted);margin-left:auto" id="logCount"></span>
          </div>
          <div class="table-wrap"><div id="logsBody"></div></div>
        </div>
        <!-- Relatórios -->
        <div class="tab-content" id="tabRelatorios">
          <div class="report-grid" id="reportGrid"></div>
          <div style="margin-bottom:.5rem;font-size:.75rem;color:var(--muted)">Últimas mensagens</div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Data</th><th>Número</th><th>Status</th></tr></thead>
              <tbody id="reportBody"><tr><td colspan="3" class="empty">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
        <!-- Campanhas -->
        <div class="tab-content" id="tabCampanhas">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.85rem;flex-wrap:wrap;gap:.5rem">
            <div>
              <h3 style="margin:0;font-size:.9rem">Campanhas de Envio</h3>
              <div style="font-size:.68rem;color:var(--muted);margin-top:2px">Envie mensagens em lote com delays inteligentes</div>
            </div>
            <button class="btn btn-primary btn-sm" onclick="openCampaignModal()">+ Nova Campanha</button>
          </div>
          <div id="campaignStats" style="display:flex;gap:.5rem;margin-bottom:.65rem;flex-wrap:wrap"></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Nome</th><th>Status</th><th>Enviado</th><th>Pendente</th><th>Erros</th><th>Criada</th><th>Ações</th></tr></thead>
              <tbody id="campaignsBody"><tr><td colspan="7" class="empty">Nenhuma campanha criada.</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<!-- QR Modal -->
<div class="modal-overlay" id="qrModal">
  <div class="modal">
    <h3 id="qrModalTitle">Conectando Conta</h3>
    <p class="sub">Escaneie o QR Code com seu WhatsApp</p>
    <div class="qr-box">
      <img id="qrModalImg" src="" alt="QR Code" style="display:none">
      <div id="qrModalPlaceholder" style="width:200px;height:200px;border-radius:8px;background:var(--bg);border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;margin:auto;font-size:.7rem;color:var(--muted)">Aguardando QR Code...</div>
    </div>
    <div class="qr-timer" id="qrTimer"></div>
    <div class="modal-actions">
      <button class="btn btn-warning btn-sm" onclick="refreshQR()">Atualizar QR</button>
      <button class="btn btn-danger btn-sm" onclick="cancelQR()">Cancelar</button>
    </div>
  </div>
</div>
<!-- WA Message Modal -->
<div class="modal-overlay" id="waMsgModal">
  <div class="modal" style="max-width:600px">
    <h3 id="waMsgModalTitle">Nova Mensagem</h3>
    <input type="hidden" id="waMsgEditId">
    <textarea id="waMsgText" rows="8" placeholder="Digite a mensagem... Use variáveis: {saudacao}, {primeiro_nome}, {nome}, {cpf}, {telefone}, {link}, {link_pagamento}, {data}, {hora}" style="width:100%;font-family:inherit;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);resize:vertical"></textarea>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:.5rem">
      <label style="font-size:.72rem;display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" id="waMsgActive" checked style="accent-color:var(--accent)">
        <span>Ativa (enviada aleatoriamente)</span>
      </label>
      <span style="font-size:.65rem;color:var(--muted)" id="waMsgCharCount">0/1600</span>
    </div>
    <div class="modal-actions" style="margin-top:.75rem">
      <button class="btn btn-primary" onclick="saveWAMsg()">Salvar</button>
      <button class="btn btn-outline" onclick="closeWAMsgModal()">Cancelar</button>
    </div>
  </div>
</div>
<!-- Campaign Modal -->
<div class="modal-overlay" id="campaignModal">
  <div class="modal" style="max-width:650px">
    <h3>Nova Campanha</h3>
    <div style="display:grid;gap:.75rem;margin-top:.75rem">
      <div>
        <label style="font-size:.72rem;font-weight:600;display:block;margin-bottom:4px">Nome da Campanha</label>
        <input id="campaignName" type="text" placeholder="Ex: Promocao Junho 2026" style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.82rem">
      </div>
      <div>
        <label style="font-size:.72rem;font-weight:600;display:block;margin-bottom:4px">Numeros (max. 100, um por linha)</label>
        <textarea id="campaignNumbers" rows="5" placeholder="5511999999999&#10;5521988888888&#10;5531977777777" style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-family:monospace;font-size:.78rem;resize:vertical"></textarea>
        <div style="font-size:.65rem;color:var(--muted);margin-top:2px"><span id="campaignNumCount">0</span>/100 numeros</div>
      </div>
      <div>
        <label style="font-size:.72rem;font-weight:600;display:block;margin-bottom:4px">Modelos de Mensagem (max. 5, alterna automaticamente)</label>
        <div id="campaignMsgFields">
          <div style="display:flex;gap:.3rem;margin-bottom:.3rem">
            <textarea class="campaign-msg-input" rows="2" placeholder="Mensagem 1... Variaveis: {saudacao}, {primeiro_nome}, {nome_completo}, {hora}, {minuto}, {emoji}, {cpf_mascarado}, {cpf}, {telefone}" style="flex:1;padding:.4rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.78rem;resize:vertical"></textarea>
            <button class="btn btn-danger btn-sm" onclick="removeCampaignMsg(this)" style="align-self:flex-start" title="Remover">✕</button>
          </div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="addCampaignMsgField()" style="margin-top:.3rem">+ Adicionar Mensagem</button>
        <div style="font-size:.65rem;color:var(--muted);margin-top:2px">Variaveis: <code>{saudacao}</code> <code>{primeiro_nome}</code> <code>{nome_completo}</code> <code>{hora}</code> <code>{minuto}</code> <code>{emoji}</code> <code>{cpf_mascarado}</code></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
        <div>
          <label style="font-size:.72rem;font-weight:600;display:block;margin-bottom:4px">Delay Minimo (segundos)</label>
          <input id="campaignDelayMin" type="number" value="180" min="60" max="600" style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.82rem">
        </div>
        <div>
          <label style="font-size:.72rem;font-weight:600;display:block;margin-bottom:4px">Delay Maximo (segundos)</label>
          <input id="campaignDelayMax" type="number" value="300" min="60" max="600" style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.82rem">
        </div>
      </div>
      <div style="font-size:.68rem;color:var(--muted);background:var(--bg);padding:.5rem;border-radius:6px">
        <strong>Delays inteligentes:</strong> O sistema alternara aleatoriamente entre o minimo e maximo configurado para simular comportamento humano. Com stealth ativo, delays adicionais de 4-14s sao aplicados entre cada envio.
      </div>
    </div>
    <div class="modal-actions" style="margin-top:.75rem">
      <button class="btn btn-primary" onclick="saveCampaign()">Criar Campanha</button>
      <button class="btn btn-outline" onclick="closeCampaignModal()">Cancelar</button>
    </div>
  </div>
</div>
<div class="toast" id="toastContainer"></div>
<script>
var qrModalIndex = -1;
var qrTimer = null;
var waMsgEditId = null;

function doLogin() {
  var key = document.getElementById("loginKey").value.trim();
  if (!key) return;
  localStorage.setItem("wa_admin_token", key);
  document.getElementById("loginError").style.display = "none";
  api("/api/admin/status").then(function(r) {
    if (r.success) {
      document.getElementById("loginScreen").style.display = "none";
      document.querySelector(".layout").style.display = "";
      startPolling();
    } else {
      localStorage.removeItem("wa_admin_token");
      document.getElementById("loginError").style.display = "block";
    }
  });
}
document.getElementById("loginKey").addEventListener("keydown", function(e) { if (e.key === "Enter") doLogin() });

(function checkAuth() {
  var token = getAuthToken();
  if (!token) {
    document.getElementById("loginScreen").style.display = "flex";
    document.querySelector(".layout").style.display = "none";
    return;
  }
  api("/api/admin/status").then(function(r) {
    if (!r.success) {
      localStorage.removeItem("wa_admin_token");
      document.getElementById("loginScreen").style.display = "flex";
      document.querySelector(".layout").style.display = "none";
    } else {
      document.getElementById("loginScreen").style.display = "none";
      document.querySelector(".layout").style.display = "";
      startPolling();
    }
  });
})();

function toast(msg, type) {
  var el = document.createElement("div");
  el.className = "toast-item toast-" + (type || "info");
  el.textContent = msg;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(function(){ el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(function(){ el.remove() }, 300) }, 3500);
}

function q(s) { return document.querySelector(s) }
function qa(s) { return document.querySelectorAll(s) }
function byId(s) { return document.getElementById(s) }

function getAuthToken() { return localStorage.getItem("wa_admin_token") || "" }

function api(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  var token = getAuthToken();
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  if (opts.body) { opts.body = JSON.stringify(opts.body); opts.headers["Content-Type"] = "application/json" }
  return fetch(url, opts).then(function(r) {
    if (r.status === 401) { localStorage.removeItem("wa_admin_token"); showLogin(); return { success: false, error: "Sessao expirada" } }
    if (!r.ok) return { success: false, error: "HTTP " + r.status };
    return r.json();
  }).catch(function(e) { return { success: false, error: String(e) } });
}

function showLogin() {
  document.getElementById("loginScreen").style.display = "flex";
  document.querySelector(".layout").style.display = "none";
}

function showError(msg) {
  var el = byId("topStatusText");
  if (el) el.innerHTML = '<span style="color:var(--red)">⚠ ' + esc(msg) + '</span>';
}

function esc(s) { if (!s) return ""; var d = document.createElement("div"); d.textContent = s; return d.innerHTML }

function statusDot(s) { return "status-dot--" + (s || "starting") }
function statusLabel(s) { return ({ connected:"Conectado", awaiting_qr:"Aguardando QR", reconnecting:"Reconectando", starting:"Iniciando", offline:"Desconectado", auth_failure:"Falha Auth", error:"Erro" })[s] || s }
function statusTag(s) { return ({ connected:"success", awaiting_qr:"warning", reconnecting:"warning", starting:"info", offline:"error", auth_failure:"error", error:"error" })[s] || "info" }
function fmt(iso) { return iso ? new Date(iso).toLocaleString("pt-BR") : "---" }
function fmtPhone(p) {
  if (!p) return "---"; p = String(p).replace(/\D/g, "");
  if (p.startsWith("55")) p = p.slice(2);
  if (p.length === 11) return "+55 (" + p.slice(0,2) + ") " + p.slice(2,7) + "-" + p.slice(7);
  if (p.length === 10) return "+55 (" + p.slice(0,2) + ") " + p.slice(2,6) + "-" + p.slice(6);
  return "+55 " + p;
}

function renderKPI(data) {
  var acc = data.accounts || { total:0, connected:0, offline:0 };
  var msgs = data.messages || {};
  var bs = (msgs.allTime || {}).byStatus || {};
  var integ = data.integrations || { total:0 };
  var monthTotal = (msgs.periods || {}).month ? msgs.periods.month.total : 0;
  byId("kpiGrid").innerHTML =
    '<div class="kpi kpi-green"><div class="kpi-value">' + acc.connected + '</div><div class="kpi-label">Conectadas</div></div>' +
    '<div class="kpi kpi-red"><div class="kpi-value">' + acc.offline + '</div><div class="kpi-label">Offline</div></div>' +
    '<div class="kpi kpi-blue"><div class="kpi-value">' + (bs.sent||0) + '</div><div class="kpi-label">Enviadas</div></div>' +
    '<div class="kpi kpi-green"><div class="kpi-value">' + (bs.delivered||0) + '</div><div class="kpi-label">Entregues</div></div>' +
    '<div class="kpi kpi-red"><div class="kpi-value">' + (bs.failed||0) + '</div><div class="kpi-label">Falhas</div></div>' +
    '<div class="kpi kpi-blue"><div class="kpi-value">' + monthTotal + '</div><div class="kpi-label">Este Mês</div></div>';
  byId("sTotalAcc").textContent = acc.total;
  byId("sConnectedAcc").textContent = acc.connected;
  byId("sMonthMsg").textContent = monthTotal;
  byId("sIntegracoes").textContent = integ.total;
}

function renderAccounts(accounts) {
  var con = 0, off = 0;
  accounts.forEach(function(a) { if (a.state === "connected") con++; else off++ });
  byId("accSummary").textContent = con + " conectada(s) - " + off + " offline";
  byId("sidebarAccounts").innerHTML = accounts.map(function(a) {
    return '<div class="sidebar-account"><span class="dot ' + statusDot(a.state) + '"></span><span class="name">' + a.label + '</span><span class="val">' + statusLabel(a.state) + '</span></div>';
  }).join("");
  byId("accountsGrid").innerHTML = accounts.map(function(a, i) {
    var qrHtml = (a.qr && a.state === "awaiting_qr") ? '<div class="ac-qr"><img src="' + a.qr + '" alt="QR"><p>Escaneie com seu WhatsApp</p></div>' : "";
    var profileHtml = a.profileName ? '<div class="profile-info"><strong>' + esc(a.profileName) + '</strong><small>' + (a.profileNumber ? fmtPhone(a.profileNumber) : "") + "</small></div>" : "";
    var info = "";
    if (a.connectedAt) info += "<div>Conectado: " + fmt(a.connectedAt) + "</div>";
    if (a.lastSendAt) info += "<div>Última atividade: " + fmt(a.lastSendAt) + "</div>";
    if (a.lastError) info += '<div class="error-text">Erro: ' + esc(a.lastError.error || "") + "</div>";
    return '<div class="account-card"><div class="ac-hd"><span class="ac-label">' + a.label + '</span><span class="tag ' + statusTag(a.state) + '">' + statusLabel(a.state) + '</span></div>' +
      (profileHtml ? '<div style="margin-bottom:.4rem">' + profileHtml + "</div>" : "") +
      '<div class="ac-info">' + info + "</div>" + qrHtml +
      '<div class="ac-actions">' +
        '<button class="btn btn-primary btn-sm" onclick="window._showQR(' + i + ')">QR Code</button>' +
        '<button class="btn btn-outline btn-sm" onclick="window._acConnect(' + i + ')">Conectar</button>' +
        '<button class="btn btn-warning btn-sm" onclick="window._acReconnect(' + i + ')">Reconectar</button>' +
        '<button class="btn btn-danger btn-sm" onclick="if(confirm(&#39;Desconectar ' + a.label + '?&#39;))window._acDisconnect(' + i + ')">Desconectar</button>' +
      "</div></div>";
  }).join("");
}

function renderQueue(stats, messages) {
  var grid = byId("queueGrid");
  grid.innerHTML =
    '<div class="queue-card"><div class="qty" style="color:var(--accent)">' + (stats.pending||0) + '</div><div class="qlabel">Pendentes</div></div>' +
    '<div class="queue-card"><div class="qty" style="color:var(--yellow)">' + (stats.processing||0) + '</div><div class="qlabel">Processando</div></div>' +
    '<div class="queue-card"><div class="qty" style="color:var(--green)">' + (stats.completed||0) + '</div><div class="qlabel">Completados</div></div>' +
    '<div class="queue-card"><div class="qty" style="color:var(--red)">' + (stats.failed||0) + '</div><div class="qlabel">Falhou</div></div>' +
    '<div class="queue-card"><div class="qty" style="color:var(--red)">' + (stats.deadletter||0) + '</div><div class="qlabel">Dead Letter</div></div>' +
    '<div class="queue-card"><div class="qty" style="color:var(--muted)">' + stats.total + '</div><div class="qlabel">Total</div></div>';
  byId("sQueuePend").textContent = stats.pending || 0;
  byId("queueCount").textContent = messages.length + " mensagens";
  var list = byId("queueList");
  if (!messages.length) { list.innerHTML = '<div class="empty">Nenhuma mensagem na fila.</div>'; return }
  list.innerHTML = messages.map(function(m) {
    var sc = m.status === "completed" ? "success" : m.status === "deadletter" ? "error" : m.status === "failed" ? "error" : m.status === "processing" ? "warning" : "info";
    var sl = { pending:"Pendente", processing:"Processando", completed:"Completado", failed:"Falhou", deadletter:"Dead Letter" };
    var actions = "";
    if (m.status === "failed" || m.status === "deadletter") actions = '<button class="btn btn-sm btn-warning" onclick="window._retryMsg(' + m.id + ')" style="font-size:.62rem;padding:.15rem .4rem">Retry</button>';
    return '<div class="qitem"><span class="qphone">' + (m.phone || "---") + '</span><span class="qmsg">' + esc((m.message||"").slice(0,60)) + '</span><span class="qretry">' + (m.retry_count||0) + 'x</span><span class="tag tag-' + sc + '" style="min-width:50px;text-align:center">' + (sl[m.status]||m.status) + '</span>' + actions + '</div>';
  }).join("");
}

// ---- Account Actions ----
window._acConnect = function(i) {
  api("/api/account/" + i + "/connect", { method:"POST" }).then(function() { toast("Conectando conta " + (i+1) + "...", "info") });
}
window._acReconnect = function(i) {
  api("/api/account/" + i + "/reconnect", { method:"POST" }).then(function() { toast("Reconectando conta " + (i+1) + "...", "info") });
}
window._acDisconnect = function(i) {
  api("/api/account/" + i + "/disconnect", { method:"POST" }).then(function() { toast("Conta " + (i+1) + " desconectada", "info") });
}
window._showQR = function(i) {
  qrModalIndex = i;
  byId("qrModalTitle").textContent = "Conta " + (i+1);
  byId("qrModalImg").style.display = "none";
  byId("qrModalPlaceholder").style.display = "flex";
  byId("qrModal").classList.add("active");
  window._acConnect(i);
  if (qrTimer) clearInterval(qrTimer);
  var sec = 55;
  qrTimer = setInterval(function() {
    byId("qrTimer").textContent = "Renova em: " + Math.floor(sec/60) + ":" + (sec%60 < 10 ? "0" : "") + (sec%60);
    if (sec-- <= 0) { clearInterval(qrTimer); qrTimer = null }
  }, 1000);
}
window.refreshQR = function() {
  if (qrModalIndex < 0) return;
  api("/api/admin/qr/refresh/" + qrModalIndex, { method:"POST" }).then(function(d) { toast(d.message || "QR renovado", "info"); sec = 55 });
}
window.cancelQR = function() {
  if (qrModalIndex < 0) return;
  api("/api/admin/qr/cancel/" + qrModalIndex, { method:"POST" }).then(function() { toast("Conexão cancelada", "info") });
  byId("qrModal").classList.remove("active");
  qrModalIndex = -1;
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
}

// ---- WhatsApp Messages (Mensagens EdgeOne) ----
window.openWAMsgModal = function(id) {
  var modal = byId("waMsgModal");
  var textarea = byId("waMsgText");
  var title = byId("waMsgModalTitle");
  var activeCheck = byId("waMsgActive");
  var charCount = byId("waMsgCharCount");
  if (id !== undefined) {
    waMsgEditId = id;
    title.textContent = "Editar Mensagem";
    api("/api/admin/whatsapp-messages").then(function(r) {
      if (r.success) {
        var msg = r.messages.find(function(m) { return m.id === id });
        if (msg) {
          textarea.value = msg.text || "";
          activeCheck.checked = !!msg.active;
          charCount.textContent = textarea.value.length + "/1600";
        }
      }
    });
  } else {
    waMsgEditId = null;
    title.textContent = "Nova Mensagem";
    textarea.value = "";
    activeCheck.checked = true;
    charCount.textContent = "0/1600";
  }
  modal.classList.add("active");
};

window.closeWAMsgModal = function() {
  byId("waMsgModal").classList.remove("active");
  waMsgEditId = null;
};

window.saveWAMsg = function() {
  var text = byId("waMsgText").value.trim();
  var active = byId("waMsgActive").checked;
  if (!text) { toast("Mensagem vazia", "error"); return }
  var url = waMsgEditId ? "/api/admin/whatsapp-messages/" + waMsgEditId : "/api/admin/whatsapp-messages";
  var method = waMsgEditId ? "PUT" : "POST";
  api(url, { method: method, body: { text: text, active: active } }).then(function(r) {
    if (r.success) {
      toast(waMsgEditId ? "Mensagem atualizada" : "Mensagem criada", "success");
      closeWAMsgModal();
      loadWAMessages();
    } else {
      toast(r.error || "Erro", "error");
    }
  });
};

async function loadWAMessages() {
  var r = await api("/api/admin/whatsapp-messages");
  var tb = byId("waMsgsBody");
  var statsEl = byId("waMsgStats");
  if (!r.success || !r.messages || !r.messages.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">Nenhuma mensagem. Crie mensagens para envio aleatório pelo EdgeOne.</td></tr>';
    statsEl.innerHTML = '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--muted);font-size:1rem">0</div><div class="qlabel">Total</div></div><div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--green);font-size:1rem">0</div><div class="qlabel">Ativas</div></div>';
    return;
  }
  var total = r.messages.length;
  var activeCount = r.messages.filter(function(m) { return m.active }).length;
  statsEl.innerHTML =
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--accent);font-size:1rem">' + total + '</div><div class="qlabel">Total</div></div>' +
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--green);font-size:1rem">' + activeCount + '</div><div class="qlabel">Ativas</div></div>' +
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--muted);font-size:1rem">' + (total - activeCount) + '</div><div class="qlabel">Inativas</div></div>';
  tb.innerHTML = r.messages.map(function(m) {
    var short = m.text.length > 100 ? m.text.slice(0, 100) + "..." : m.text;
    var toggleColor = m.active ? "var(--green)" : "var(--muted)";
    var toggleLabel = m.active ? "ATIVA" : "INATIVA";
    var toggleIcon = m.active ? "✅" : "⬜";
    return '<tr style="opacity:' + (m.active ? '1' : '0.55') + '">' +
      '<td>' + m.id + '</td>' +
      '<td title="' + esc(m.text) + '">' + esc(short) + '</td>' +
      '<td><span style="cursor:pointer;font-size:.68rem;font-weight:600;color:' + toggleColor + '" onclick="toggleWAMsg(' + m.id + ')">' + toggleIcon + ' ' + toggleLabel + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-outline btn-sm" onclick="openWAMsgModal(' + m.id + ')">Editar</button> ' +
        '<button class="btn btn-danger btn-sm" onclick="deleteWAMsg(' + m.id + ')">Excluir</button>' +
      '</td></tr>';
  }).join("");
}

window.toggleWAMsg = function(id) {
  api("/api/admin/whatsapp-messages/" + id + "/toggle", { method: "POST" }).then(function(r) {
    if (r.success) {
      toast(r.active ? "Mensagem ativada" : "Mensagem desativada", "success");
      loadWAMessages();
    } else {
      toast(r.error || "Erro", "error");
    }
  });
};

window.deleteWAMsg = function(id) {
  if (!confirm("Excluir mensagem #" + id + "?")) return;
  api("/api/admin/whatsapp-messages/" + id, { method: "DELETE" }).then(function(r) {
    if (r.success) { toast("Excluída", "success"); loadWAMessages(); }
    else toast(r.error || "Erro", "error");
  });
};

// char counter
document.addEventListener("input", function(e) {
  if (e.target && e.target.id === "waMsgText") {
    byId("waMsgCharCount").textContent = e.target.value.length + "/1600";
  }
});
window._retryMsg = function(id) {
  api("/api/queue/retry/" + id, { method:"POST" }).then(function(d) { toast(d.message || "Reenfileirado", "info"); loadQueue() });
}
window._refreshQR = refreshQR;
window._cancelQR = cancelQR;
window._addAccount = addAccount;
window._retryAll = retryAll;
window._clearCompleted = clearCompleted;
window._fullRefresh = fullRefresh;

function openTab(id, el) {
  qa(".tab").forEach(function(t) { t.classList.remove("active") });
  qa(".tab-content").forEach(function(t) { t.classList.remove("active") });
  el.classList.add("active");
  var tabId = "tab" + id.charAt(0).toUpperCase() + id.slice(1);
  var tabEl = byId(tabId);
  if (tabEl) tabEl.classList.add("active");
  if (id === "mensagens") loadMessages();
  if (id === "contatos") loadContacts();
  if (id === "logs") loadLogs();
  if (id === "relatorios") loadReports();
  if (id === "templates") loadWAMessages();
  if (id === "fila") loadQueue();
  if (id === "campanhas") loadCampaigns();
}

qa("#mainTabs .tab").forEach(function(tab) {
  tab.addEventListener("click", function() { openTab(tab.dataset.tab, tab) });
});

async function fetchDashboard() {
  var data = await api("/api/admin/dashboard");
  if (!data.success) { showError("Dashboard: " + (data.error || "sem resposta")); return }
  renderKPI(data);
  var dot = byId("topStatusDot");
  var txt = byId("topStatusText");
  loadStealth();
  var state = (data.accounts && data.accounts.connected > 0) ? "connected" : (data.accounts && data.accounts.total > 0) ? "offline" : "starting";
  dot.className = "status-dot " + statusDot(state);
  txt.textContent = data.accounts ? (data.accounts.connected + " de " + data.accounts.total + " contas conectadas") : "Carregando...";
  byId("topUptime").textContent = data.uptimeSeconds ? Math.floor(data.uptimeSeconds / 60) + "min online" : "";
  var d2 = await api("/api/admin/status");
  if (!d2.success || !d2.accounts) { showError("Status: " + ((d2 && d2.error) || "sem dados")); return }
  renderAccounts(d2.accounts);
  if (qrModalIndex >= 0) {
    var acc = d2.accounts[qrModalIndex];
    if (acc && acc.qr) {
      byId("qrModalImg").src = acc.qr;
      byId("qrModalImg").style.display = "";
      byId("qrModalPlaceholder").style.display = "none";
    }
    if (acc && acc.state === "connected") {
      toast("Conta " + (qrModalIndex + 1) + " conectada!", "success");
      byId("qrModal").classList.remove("active");
      qrModalIndex = -1;
      if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
    }
  }
}

async function loadMessages() {
  var params = new URLSearchParams();
  var s = byId("filterMsgStatus").value;
  var p = byId("filterMsgPhone").value.trim();
  if (s) params.set("status", s);
  if (p) params.set("phone", p);
  params.set("limit", "100");
  var data = await api("/api/admin/messages?" + params.toString());
  var tb = byId("messagesBody");
  byId("msgCount").textContent = (data.messages||[]).length + " msg";
  if (!data.messages || !data.messages.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">Nenhuma mensagem.</td></tr>'; return }
  tb.innerHTML = data.messages.map(function(m) {
    var sc = (m.status === "sent"||m.status==="received"||m.status==="delivered") ? "success" : m.status==="failed" ? "error" : "warning";
    var sl = { sent:"Enviado", received:"Recebida", delivered:"Entregue", read:"Lida", failed:"Falhou" };
    return '<tr><td>' + fmt(m.timestamp) + '</td><td>' + fmtPhone(m.to) + '</td><td><span class="tag tag-' + sc + '">' + (sl[m.status]||m.status) + '</span></td><td>' + (m.source||"api") + "</td></tr>";
  }).join("");
}

async function loadQueue() {
  var stats = await api("/api/queue/stats");
  var msgs = await api("/api/queue/messages?limit=50");
  if (stats.success) renderQueue(stats.stats || {}, msgs.messages || []);
}

async function loadContacts() {
  var data = await api("/api/admin/contacts");
  var el = byId("contactsBody");
  if (!data.contacts || !data.contacts.length) { el.innerHTML = '<div class="empty">Nenhum contato.</div>'; return }
  el.innerHTML = data.contacts.map(function(c) {
    var sc = (c.lastStatus==="sent"||c.lastStatus==="received"||c.lastStatus==="delivered") ? "success" : c.lastStatus==="failed" ? "error" : "warning";
    var sl = { sent:"Enviado", received:"Recebida", delivered:"Entregue", read:"Lida", failed:"Falhou" };
    return '<div class="contact-item"><div><div class="contact-phone">' + fmtPhone(c.phone) + '</div><div style="color:var(--muted);font-size:.68rem">' + fmt(c.lastSendAt) + '</div></div><div style="text-align:right"><span class="tag tag-' + sc + '">' + (sl[c.lastStatus]||c.lastStatus) + '</span><div style="margin-top:3px;font-size:.68rem;color:var(--muted)">' + (c.count||0) + " msg</div></div></div>";
  }).join("");
}

async function loadLogs() {
  var params = new URLSearchParams();
  var e = byId("filterLogEvent").value.trim();
  if (e) params.set("event", e);
  params.set("limit", "200");
  var data = await api("/api/admin/logs?" + params.toString());
  var el = byId("logsBody");
  byId("logCount").textContent = (data.logs||[]).length + " logs";
  if (!data.logs || !data.logs.length) { el.innerHTML = '<div class="empty">Nenhum log.</div>'; return }
  el.innerHTML = data.logs.map(function(l) {
    var ac = (l.data && l.data.account !== undefined) ? l.data.account : 0;
    return '<div class="log-item"><span class="log-time">' + fmt(l.timestamp) + '</span><span class="log-ac">' + (ac+1) + '</span><span class="log-event">' + esc(l.event||"") + '</span><span class="log-desc">' + esc(l.description||"") + "</span></div>";
  }).join("");
}

async function loadReports() {
  var dr = await api("/api/admin/messages/stats");
  var stats = dr.stats || {};
  var periods = [{ key:"today", label:"Hoje" },{ key:"week", label:"Esta Semana" },{ key:"month", label:"Este Mês" }];
  byId("reportGrid").innerHTML = periods.map(function(p) {
    var d = stats[p.key] || { total:0, byStatus:{} };
    var bs = d.byStatus || {};
    return '<div class="report-card"><div class="rp-period">' + p.label + '</div><div class="rp-total">' + d.total + '</div><div class="rp-detail"><span style="color:var(--green)">' + (bs.sent||0) + '</span> | <span style="color:var(--yellow)">' + (bs.delivered||0) + '</span> | <span style="color:var(--red)">' + (bs.failed||0) + "</span></div></div>";
  }).join("") +
    '<div class="report-card"><div class="rp-period">Total Geral</div><div class="rp-total">' + ((stats.allTime||{}).total||0) + '</div><div class="rp-detail">Mensagens registradas</div></div>';
  var r2 = await api("/api/admin/messages?limit=20");
  var tb = byId("reportBody");
  if (!r2.messages || !r2.messages.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">Nenhuma mensagem.</td></tr>'; return }
  tb.innerHTML = r2.messages.map(function(m) {
    var sc = (m.status==="sent"||m.status==="received"||m.status==="delivered") ? "success" : m.status==="failed" ? "error" : "warning";
    var sl = { sent:"Enviado", received:"Recebida", delivered:"Entregue", read:"Lida", failed:"Falhou" };
    return '<tr><td>' + fmt(m.timestamp) + '</td><td>' + fmtPhone(m.to) + '</td><td><span class="tag tag-' + sc + '">' + (sl[m.status]||m.status) + "</span></td></tr>";
  }).join("");
}

async function addAccount() {
  var d = await api("/api/admin/account/add", { method:"POST" });
  if (d.success) { toast(d.message, "info"); if (d.index !== undefined) window._showQR(d.index) }
  else toast(d.error || "Erro", "error");
}

async function retryAll() {
  var d = await api("/api/queue/retry-all", { method:"POST" });
  toast(d.message || "Reenfileiradas", "info");
  loadQueue();
}

async function clearCompleted() {
  var d = await api("/api/queue/clear-completed", { method:"POST" });
  toast(d.message || "Limpos", "info");
  loadQueue();
}

async function toggleStealth() {
  var cfg = await api("/api/admin/stealth");
  var nowOn = cfg.config ? !cfg.config.enabled : true;
  var r = await api("/api/admin/stealth", { method:"POST", body:{ enabled: nowOn } });
  if (r.success) updateStealthUI(r.enabled);
}

function updateStealthUI(enabled) {
  var dot = byId("stealthDot");
  var label = byId("stealthLabel");
  if (enabled) { dot.style.background = "#06c985"; label.textContent = "Anti-ban ON" }
  else { dot.style.background = "#999"; label.textContent = "Anti-ban OFF" }
}

async function loadStealth() {
  var r = await api("/api/admin/stealth");
  if (r.success) updateStealthUI(r.config && r.config.enabled);
}

function fullRefresh() {
  fetchDashboard();
  loadMessages();
  loadContacts();
  loadLogs();
  loadReports();
  loadQueue();
  loadWAMessages();
  loadCampaigns();
}

// ---- Campanhas ----
var campaignData = [];

async function loadCampaigns() {
  var r = await api("/api/campaigns");
  if (!r.success) return;
  campaignData = r.campaigns || [];
  var tb = byId("campaignsBody");
  var statsEl = byId("campaignStats");
  var total = campaignData.length;
  var running = campaignData.filter(function(c) { return c.status === "running" }).length;
  var completed = campaignData.filter(function(c) { return c.status === "completed" }).length;
  var paused = campaignData.filter(function(c) { return c.status === "paused" }).length;
  statsEl.innerHTML =
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--accent);font-size:1rem">' + total + '</div><div class="qlabel">Total</div></div>' +
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--green);font-size:1rem">' + running + '</div><div class="qlabel">Rodando</div></div>' +
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:#f59e0b;font-size:1rem">' + paused + '</div><div class="qlabel">Pausadas</div></div>' +
    '<div class="queue-card" style="padding:.4rem .6rem"><div class="qty" style="color:var(--muted);font-size:1rem">' + completed + '</div><div class="qlabel">Concluidas</div></div>';
  if (!campaignData.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma campanha criada.</td></tr>';
    return;
  }
  tb.innerHTML = campaignData.map(function(c) {
    var statusColors = { draft: "#999", running: "var(--green)", paused: "#f59e0b", completed: "var(--accent)", cancelled: "#ef4444" };
    var statusLabels = { draft: "RASCUNHO", running: "RODANDO", paused: "PAUSADA", completed: "CONCLUIDA", cancelled: "CANCELADA" };
    var color = statusColors[c.status] || "#999";
    var label = statusLabels[c.status] || c.status;
    var actions = "";
    if (c.status === "draft" || c.status === "paused") actions += '<button class="btn btn-primary btn-sm" onclick="startCampaign(' + c.id + ')">Iniciar</button> ';
    if (c.status === "running") actions += '<button class="btn btn-warning btn-sm" onclick="pauseCampaign(' + c.id + ')">Pausar</button> ';
    if (c.status !== "completed" && c.status !== "cancelled") actions += '<button class="btn btn-danger btn-sm" onclick="cancelCampaign(' + c.id + ')">Cancelar</button> ';
    actions += '<button class="btn btn-outline btn-sm" onclick="viewCampaign(' + c.id + ')">Detalhes</button>';
    var date = c.created_at ? c.created_at.slice(0, 16).replace(" ", " ") : "-";
    return '<tr>' +
      '<td style="font-weight:600">' + esc(c.name) + '</td>' +
      '<td><span style="color:' + color + ';font-weight:600;font-size:.72rem">' + label + '</span></td>' +
      '<td>' + (c.sent_count || 0) + '</td>' +
      '<td>' + (c.pending_count || 0) + '</td>' +
      '<td>' + (c.error_count || 0) + '</td>' +
      '<td style="font-size:.72rem">' + date + '</td>' +
      '<td style="white-space:nowrap">' + actions + '</td>' +
      '</tr>';
  }).join("");
}

window.openCampaignModal = function() {
  byId("campaignModal").classList.add("active");
  byId("campaignName").value = "";
  byId("campaignNumbers").value = "";
  byId("campaignNumCount").textContent = "0";
  byId("campaignDelayMin").value = "180";
  byId("campaignDelayMax").value = "300";
  var fields = byId("campaignMsgFields");
  fields.innerHTML = '<div style="display:flex;gap:.3rem;margin-bottom:.3rem">' +
    '<textarea class="campaign-msg-input" rows="2" placeholder="Mensagem 1..." style="flex:1;padding:.4rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.78rem;resize:vertical"></textarea>' +
    '<button class="btn btn-danger btn-sm" onclick="removeCampaignMsg(this)" style="align-self:flex-start" title="Remover">✕</button></div>';
};

window.closeCampaignModal = function() {
  byId("campaignModal").classList.remove("active");
};

window.addCampaignMsgField = function() {
  var fields = byId("campaignMsgFields");
  var count = fields.querySelectorAll(".campaign-msg-input").length;
  if (count >= 5) { toast("Maximo de 5 mensagens", "error"); return; }
  var div = document.createElement("div");
  div.style.cssText = "display:flex;gap:.3rem;margin-bottom:.3rem";
  div.innerHTML = '<textarea class="campaign-msg-input" rows="2" placeholder="Mensagem ' + (count + 1) + '..." style="flex:1;padding:.4rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.78rem;resize:vertical"></textarea>' +
    '<button class="btn btn-danger btn-sm" onclick="removeCampaignMsg(this)" style="align-self:flex-start" title="Remover">✕</button>';
  fields.appendChild(div);
};

window.removeCampaignMsg = function(btn) {
  var fields = byId("campaignMsgFields");
  if (fields.querySelectorAll(".campaign-msg-input").length <= 1) { toast("Minimo de 1 mensagem", "error"); return; }
  btn.closest("div[style*=flex]").remove();
};

byId("campaignNumbers").addEventListener("input", function() {
  var lines = this.value.split("\\n").filter(function(l) { return l.trim() });
  byId("campaignNumCount").textContent = lines.length;
});

window.saveCampaign = async function() {
  var name = byId("campaignName").value.trim();
  var numbersRaw = byId("campaignNumbers").value;
  var delayMin = parseInt(byId("campaignDelayMin").value, 10) || 180;
  var delayMax = parseInt(byId("campaignDelayMax").value, 10) || 300;
  var msgInputs = document.querySelectorAll(".campaign-msg-input");
  var messages = [];
  msgInputs.forEach(function(el) {
    var v = el.value.trim();
    if (v) messages.push(v);
  });
  var numbers = numbersRaw.split("\\n").map(function(l) { return l.trim() }).filter(function(l) { return l });
  if (!name) { toast("Informe o nome da campanha", "error"); return; }
  if (!numbers.length) { toast("Informe pelo menos 1 numero", "error"); return; }
  if (numbers.length > 100) { toast("Maximo de 100 numeros", "error"); return; }
  if (!messages.length) { toast("Informe pelo menos 1 mensagem", "error"); return; }
  if (messages.length > 5) { toast("Maximo de 5 mensagens", "error"); return; }
  if (delayMin < 60) { toast("Delay minimo: 60 segundos", "error"); return; }
  if (delayMax < delayMin) { toast("Delay maximo deve ser >= minimo", "error"); return; }
  var r = await api("/api/campaigns", {
    method: "POST",
    body: { name, messages, numbers, delayMin, delayMax }
  });
  if (r.success) {
    toast("Campanha criada com sucesso!", "success");
    closeCampaignModal();
    loadCampaigns();
  } else {
    toast(r.error || "Erro ao criar campanha", "error");
  }
};

window.startCampaign = async function(id) {
  if (!confirm("Iniciar esta campanha? Os envios comecarao imediatamente.")) return;
  var r = await api("/api/campaigns/" + id + "/start", { method: "POST" });
  if (r.success) {
    toast("Campanha iniciada!", "success");
    loadCampaigns();
  } else {
    toast(r.error || "Erro ao iniciar", "error");
  }
};

window.pauseCampaign = async function(id) {
  var r = await api("/api/campaigns/" + id + "/pause", { method: "POST" });
  if (r.success) {
    toast("Campanha pausada", "info");
    loadCampaigns();
  } else {
    toast(r.error || "Erro ao pausar", "error");
  }
};

window.cancelCampaign = async function(id) {
  if (!confirm("Cancelar esta campanha? Os envios pendentes serao cancelados.")) return;
  var r = await api("/api/campaigns/" + id + "/cancel", { method: "POST" });
  if (r.success) {
    toast("Campanha cancelada", "info");
    loadCampaigns();
  } else {
    toast(r.error || "Erro ao cancelar", "error");
  }
};

window.viewCampaign = async function(id) {
  var reportR = await api("/api/campaigns/" + id + "/report");
  if (!reportR.success || !reportR.report) { toast("Erro ao carregar relatorio", "error"); return; }
  var report = reportR.report;
  var summary = reportR.summary || {};
  var msg = "📊 RELATORIO DE ENVIOS\\n";
  msg += "─────────────────────────\\n";
  msg += "Total: " + summary.total + "\\n";
  msg += "✅ Enviados: " + summary.sent + "\\n";
  msg += "⏳ Pendentes: " + summary.pending + "\\n";
  msg += "❌ Falhas: " + summary.failed + "\\n";
  msg += "📨 Na fila: " + summary.queued + "\\n";
  msg += "─────────────────────────\\n\\n";
  for (var i = 0; i < report.length; i++) {
    var r = report[i];
    var icon = r.status === "sent" || r.queueStatus === "completed" ? "✅" : r.error ? "❌" : "⏳";
    var statusLabel = r.status === "sent" || r.queueStatus === "completed" ? "ENVIADO" : r.error ? "FALHA: " + r.error : r.status === "queued" ? "NA FILA" : "PENDENTE";
    msg += icon + " " + r.phone + "\\n";
    msg += "   " + statusLabel + "\\n";
    if (r.message) msg += "   Msg: " + r.message.slice(0, 80) + "\\n";
    msg += "\\n";
  }
  alert(msg);
};

function startPolling() {
  fetchDashboard();
  loadMessages();
  loadContacts();
  loadLogs();
  loadReports();
  loadQueue();
  loadWAMessages();
  loadCampaigns();
  setInterval(fetchDashboard, 5000);
  setInterval(loadQueue, 8000);
  setInterval(loadMessages, 10000);
  setInterval(loadCampaigns, 12000);
}
</script>
</body>
</html>`;
