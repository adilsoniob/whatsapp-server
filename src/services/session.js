import pkg from "whatsapp-web.js";
import qrcode from "qrcode";
import { log } from "../logger.js";
import * as queue from "./queue.js";

const Client = pkg.Client || pkg.default?.Client;
const LocalAuth = pkg.LocalAuth || pkg.default?.LocalAuth;

const RATE = { maxPerMinute: 5, intervalMs: 6000, sent: [], lastSend: 0 };

const STATES = Object.freeze({
  STARTING: "starting",
  AWAITING_QR: "awaiting_qr",
  CONNECTED: "connected",
  OFFLINE: "offline",
  AUTH_FAILURE: "auth_failure",
  RECONNECTING: "reconnecting",
  ERROR: "error",
});

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--disable-gpu",
  "--mute-audio",
];

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout após ${ms}ms`)), ms)
    ),
  ]);

export class WhatsAppSession {
  constructor(index, io, storage, config) {
    this.index = index;
    this.io = io;
    this.storage = storage;
    this.config = config;
    this.status = { state: STATES.STARTING, qr: null, message: "Inicializando..." };
    this.client = null;
    this.initializing = null;
    this.reconnectAttempts = 0;
    this.profileName = null;
    this.profileNumber = null;
    this.profilePic = null;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastSendAt = null;
    this.lastError = null;
    this._destroyed = false;
    this._msgQueue = [];
    this._processingQueue = false;
    this._queueWorkerTimer = null;
    this._queueProcessing = false;
  }

  get accountLabel() {
    return `WhatsApp ${String(this.index + 1).padStart(2, "0")}`;
  }

  isReady() {
    return this.status.state === STATES.CONNECTED && this.client !== null;
  }

  getStatus() {
    return {
      index: this.index,
      label: this.accountLabel,
      state: this.status.state,
      qr: this.status.qr,
      message: this.status.message,
      profileName: this.profileName,
      profileNumber: this.profileNumber,
      profilePic: this.profilePic,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastSendAt: this.lastSendAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  emit(event, data) {
    this.io?.emit(event, { account: this.index, ...data });
  }

  async sendMessage(number, message) {
    if (!this.client) return this._fail("NOT_INITIALIZED", "Cliente não inicializado.");
    if (!this.isReady()) return this._fail("NOT_READY", "WhatsApp não está conectado.");

    const cleanNumber = String(number || "").replace(/\D+/g, "");
    if (cleanNumber.length < 10) {
      return this._fail("BAD_NUMBER", `Número inválido (${cleanNumber.length} dígitos).`, cleanNumber);
    }
    if (!cleanNumber.startsWith("55") && cleanNumber.length < 12) {
      return this._fail("BAD_NUMBER", "Número precisa ter DDI 55 (Brasil).", cleanNumber);
    }
    if (!message || !message.trim()) {
      return this._fail("EMPTY_MESSAGE", "Mensagem vazia.");
    }

    return new Promise((resolve) => {
      this._msgQueue.push({ cleanNumber, message, resolve });
      this._processQueue();
    });
  }

  async sendFromQueue(queueId, phone, message) {
    const result = await this._doSend(phone, message);
    if (result.success) {
      await queue.complete(queueId);
      this.storage?.addMessage({ to: phone, status: "sent", source: "api", account: this.index, metadata: JSON.stringify({ queueId }) });
    } else if (result.code === "RATE_LIMIT") {
      await queue.revertToPending(queueId);
    } else if (result.error && (result.error.includes("No LID") || result.error.includes("não registrado"))) {
      await queue.deadletter(queueId, result.error);
      this.storage?.addMessage({ to: phone, status: "failed", source: "api", account: this.index, metadata: JSON.stringify({ queueId, error: result.error }) });
    } else {
      await queue.fail(queueId, result.error || "SEND_ERROR");
      this.storage?.addMessage({ to: phone, status: "failed", source: "api", account: this.index, metadata: JSON.stringify({ queueId, error: result.error }) });
    }
    return result;
  }

  async _doSend(cleanNumber, message) {
    const now = Date.now();
    RATE.sent = RATE.sent.filter((t) => now - t < 60000);
    if (RATE.sent.length >= RATE.maxPerMinute) {
      return this._fail("RATE_LIMIT", `Limite de ${RATE.maxPerMinute} mensagens/minuto atingido.`);
    }
    const wait = RATE.intervalMs - (now - RATE.lastSend);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    let chatId = `${cleanNumber}@c.us`;
    try {
      const registered = await withTimeout(
        this.client.getNumberId(cleanNumber),
        5000,
        "getNumberId"
      );
      if (registered !== null) {
        if (typeof registered === "object" && registered._serialized) {
          chatId = registered._serialized;
        } else if (typeof registered === "string" && (registered.includes("@") || registered.length > 15)) {
          chatId = registered;
        }
      } else {
        this._addLog("warn", "getNumberId retornou null, tentando @c.us como fallback", { to: cleanNumber });
      }

      const sent = await withTimeout(
        this.client.sendMessage(chatId, message),
        this.config.sendTimeoutMs,
        "sendMessage"
      );

      this.lastSendAt = new Date().toISOString();
      RATE.lastSend = Date.now();
      RATE.sent.push(RATE.lastSend);
      const messageId = sent?.id?._serialized || sent?.id || null;
      log.info(`[${this.accountLabel}] Mensagem enviada`, { to: chatId, messageId });
      this._addLog("message_sent", `Mensagem enviada para ${cleanNumber}`, { to: cleanNumber, messageId });
      this.emit("admin:message", { to: cleanNumber, status: "sent", account: this.index });
      return { success: true, message: "Mensagem enviada com sucesso.", to: chatId, messageId };
    } catch (err) {
      this._addLog("message_error", `Erro ao enviar para ${cleanNumber}: ${err.message}`, { to: cleanNumber, error: err.message });
      return this._fail("SEND_ERROR", err.message || String(err), cleanNumber);
    }
  }

  async _processQueue() {
    if (this._processingQueue || this._msgQueue.length === 0) return;
    this._processingQueue = true;

    while (this._msgQueue.length > 0) {
      const item = this._msgQueue.shift();
      const { cleanNumber, message, resolve } = item;
      const result = await this._doSend(cleanNumber, message);
      if (result.success) {
        this.storage?.addMessage({ to: cleanNumber, status: "sent", source: "api", id: result.messageId, account: this.index });
      }
      resolve(result);
    }

    this._processingQueue = false;
  }

  async _tryDequeue() {
    if (this._queueProcessing || !this.isReady() || this._destroyed) return;
    this._queueProcessing = true;
    try {
      const now = Date.now();
      const recent = RATE.sent.filter((t) => now - t < 60000);
      if (recent.length >= RATE.maxPerMinute) {
        const oldest = recent[0] || 0;
        const wait = 60000 - (now - oldest);
        if (wait > 1000) return;
      }
      const items = await queue.dequeue(1);
      for (const item of items) {
        await this.sendFromQueue(item.id, item.phone, item.message);
      }
    } catch (err) {
      log.error(`[${this.accountLabel}] Erro no worker da fila`, { error: err.message });
    } finally {
      this._queueProcessing = false;
    }
  }

  _startQueueWorker() {
    if (this._queueWorkerTimer) return;
    const POLL_INTERVAL = 3000;
    this._queueWorkerTimer = setInterval(() => this._tryDequeue(), POLL_INTERVAL);
    this._tryDequeue();
    log.info(`[${this.accountLabel}] Worker da fila iniciado (polling a cada ${POLL_INTERVAL}ms)`);
  }

  _stopQueueWorker() {
    if (this._queueWorkerTimer) {
      clearInterval(this._queueWorkerTimer);
      this._queueWorkerTimer = null;
    }
  }

  async initialize() {
    if (this._destroyed) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        await this._destroyClientSafely();
        await this._cleanupChromiumLocks();
        const client = this._createClient();
        this._attachHandlers(client);
        this.client = client;
        this._setStatus(STATES.STARTING, "Inicializando...");
        await client.initialize();
        log.info(`[${this.accountLabel}] Cliente WhatsApp inicializado`);
      } catch (err) {
        this._setStatus(STATES.ERROR, `Erro na inicialização: ${err.message}`);
        log.error(`[${this.accountLabel}] Falha na inicialização`, { error: err.message });
        this._scheduleAutoReconnect("init_error");
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  async reconnect() {
    log.info(`[${this.accountLabel}] Reconexão manual solicitada`);
    this.reconnectAttempts = 0;
    this._setStatus(STATES.RECONNECTING, "Reconectando...");
    this.initializing = null;
    return this.initialize();
  }

  async disconnect() {
    log.info(`[${this.accountLabel}] Desconexão manual solicitada`);
    await this._destroyClientSafely();
    this._setStatus(STATES.OFFLINE, "Desconectado manualmente.");
    this.emit("disconnected", { reason: "manual" });
  }

  async removeSession() {
    log.info(`[${this.accountLabel}] Removendo sessão`);
    this._destroyed = true;
    await this._destroyClientSafely(true);
    this._setStatus(STATES.OFFLINE, "Sessão removida.");
    this.profileName = null;
    this.profileNumber = null;
    this.profilePic = null;
    this.connectedAt = null;
    this.disconnectedAt = null;
  }

  destroy() {
    log.info(`[${this.accountLabel}] Destroy solicitado`);
    this._destroyed = true;
    this._destroyClientSafely().catch(() => {});
  }

  _createClient() {
    return new Client({
      authStrategy: new LocalAuth({
        clientId: this.config.clientId + "-" + this.index,
        dataPath: "./data/.wwebjs_auth",
      }),
      puppeteer: { headless: true, args: PUPPETEER_ARGS, protocolTimeout: 120_000 },
    });
  }

  async _cleanupChromiumLocks() {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sessionDir = path.join(this.config.sessionFolder, `session-${this.config.clientId}-${this.index}`);
      if (fs.existsSync(sessionDir)) {
        for (const file of fs.readdirSync(sessionDir)) {
          if (file.startsWith("Singleton")) {
            const fp = path.join(sessionDir, file);
            try { fs.unlinkSync(fp); } catch {}
          }
        }
      }
    } catch {}
  }

  _attachHandlers(client) {
    client.on("qr", async (qr) => {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        this._setStatus(STATES.AWAITING_QR, "QR Code gerado. Escaneie com seu WhatsApp.", qrDataUrl);
        this.emit("qr", { qrDataUrl, account: this.index });
        log.info(`[${this.accountLabel}] QR Code gerado`);
      } catch (err) {
        this._setStatus(STATES.AWAITING_QR, "Erro ao gerar QR Code.");
        log.error(`[${this.accountLabel}] Falha ao gerar QR Code`, { error: err.message });
      }
    });

    client.on("ready", async () => {
      this.reconnectAttempts = 0;
      this.connectedAt = new Date().toISOString();
      this.disconnectedAt = null;
      this._setStatus(STATES.CONNECTED, "Conectado e pronto.", null);
      this.emit("connected");
      log.info(`[${this.accountLabel}] WhatsApp conectado e pronto`);
      this._addLog("connected", "WhatsApp conectado e pronto");
      this._startQueueWorker();

      try {
        const info = client.info;
        if (info) {
          this.profileName = info.pushname || info.name || null;
          this.profileNumber = info.wid?.user || info.me?.user || null;
          log.info(`[${this.accountLabel}] Perfil carregado`, { name: this.profileName, number: this.profileNumber });
          try {
            const picUrl = await client.getProfilePicUrl(info.wid._serialized);
            this.profilePic = picUrl || null;
          } catch (e) {
            log.warn(`[${this.accountLabel}] Falha ao obter foto do perfil`, { error: e.message });
          }
          this.storage?.saveSession({
            account: this.index,
            label: this.accountLabel,
            profileName: this.profileName,
            profileNumber: this.profileNumber,
            connectedAt: this.connectedAt,
          });
        } else {
          log.warn(`[${this.accountLabel}] client.info veio vazio`);
        }
      } catch (e) {
        log.error(`[${this.accountLabel}] Erro ao carregar perfil`, { error: e.message });
      }
    });

    client.on("disconnected", (reason) => {
      this.disconnectedAt = new Date().toISOString();
      this._stopQueueWorker();
      this._setStatus(STATES.OFFLINE, `Desconectado: ${reason}`);
      this.emit("disconnected", { reason, account: this.index });
      log.warn(`[${this.accountLabel}] WhatsApp desconectado`, { reason });
      this._addLog("disconnected", `WhatsApp desconectado: ${reason}`, { reason });
      if (reason !== "LOGOUT") {
        this._scheduleAutoReconnect("disconnected");
      }
    });

    client.on("auth_failure", (msg) => {
      this._setStatus(STATES.AUTH_FAILURE, `Falha de autenticação: ${msg}`);
      log.error(`[${this.accountLabel}] Falha de autenticação`, { message: msg });
      this._addLog("auth_failure", `Falha de autenticação: ${msg}`, { message: msg });
      this._scheduleAutoReconnect("auth_failure", 5000);
    });

    const stripSuffix = (s) => {
      if (!s) return "";
      return s.replace(/@\w+\.\w+$/, "").replace(/@\w+$/, "");
    };

    const isValidPhone = (s) => s && s.length >= 10 && /^\d+$/.test(s) && !s.startsWith("0");

    client.on("error", (err) => {
      const msg = String(err?.message || err || "");
      log.error(`[${this.accountLabel}] Erro no cliente WhatsApp`, { error: msg });
      this._addLog("client_error", msg, { error: msg });
      if (msg.includes("encryptMsgProtobuf") || msg.includes("nextMsgIndex")) {
        log.warn(`[${this.accountLabel}] Erro de criptografia detectado — agendando reconexão`);
        this._scheduleAutoReconnect("encrypt_error", 5000);
      }
    });

    client.on("message_ack", (msg, ack) => {
      const statusMap = { 1: "sent", 2: "received", 3: "read" };
      const status = statusMap[ack] || "sent";
      const raw = msg.from?.remote || msg.from?._serialized || msg.from;
      const phone = stripSuffix(raw);
      if (isValidPhone(phone)) {
        this.storage?.updateMessageStatus(phone, status, this.index);
        this.emit("admin:message", { to: phone, status, account: this.index });
      }
    });

    client.on("message_create", (msg) => {
      const raw = msg.to?.remote || msg.to?._serialized || msg.to;
      const rawStr = String(raw || "");
      if (!rawStr.includes("@c.us")) return;
      const phone = stripSuffix(rawStr);
      if (isValidPhone(phone)) {
        this.storage?.addMessage({ to: phone, status: "sent", source: "app", id: msg.id?._serialized, account: this.index });
        this.emit("admin:message", { to: phone, status: "sent", account: this.index });
      }
    });
  }

  async _destroyClientSafely(removeAuthFolder) {
    if (!this.client) return;
    const old = this.client;
    this.client = null;
    try {
      if (typeof old.logout === "function") {
        await withTimeout(old.logout(), 3000, "logout").catch(() => {});
      }
    } catch {}
    try {
      await withTimeout(old.destroy(), 5000, "destroy").catch(() => {});
    } catch {}
    if (removeAuthFolder) {
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const authDir = path.join(process.cwd(), "data", ".wwebjs_auth", `session-${this.config.clientId}-${this.index}`);
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true });
          log.info(`[${this.accountLabel}] Pasta de autenticação removida`);
        }
      } catch {}
    }
  }

  _scheduleAutoReconnect(reason, baseDelayMs) {
    if (this._destroyed) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      log.error(`[${this.accountLabel}] Limite de reconexão atingido`, { reason, attempts: this.reconnectAttempts });
      return;
    }
    this.reconnectAttempts += 1;
    const base = baseDelayMs ?? this.config.reconnectBaseDelayMs;
    const delay = base * Math.min(this.reconnectAttempts, 3);
    log.info(`[${this.accountLabel}] Reconexão automática agendada`, { reason, attempt: this.reconnectAttempts, delayMs: delay });
    setTimeout(() => {
      this.initialize().catch((err) =>
        log.error(`[${this.accountLabel}] Falha na reconexão automática`, { error: err.message })
      );
    }, delay);
  }

  _setStatus(state, message, qr = undefined) {
    const prevState = this.status.state;
    this.status = { state, qr: qr === undefined ? this.status.qr : qr, message };
    if (prevState !== state) {
      this._addLog("state_change", `Estado: ${prevState} -> ${state}`, { from: prevState, to: state, message });
      this.emit("admin:status", this.getStatus());
    }
  }

  _addLog(event, description, data = {}) {
    this.storage?.addLog(event, description, { ...data, account: this.index });
  }

  _fail(code, error, phone = null) {
    const entry = { at: new Date().toISOString(), code, error, phone };
    this.lastError = entry;
    log.warn(`[${this.accountLabel}] Falha no envio`, entry);
    return { success: false, code, error, phone };
  }
}
