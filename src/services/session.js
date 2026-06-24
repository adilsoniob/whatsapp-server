import pkg from "whatsapp-web.js";
import qrcode from "qrcode";
import { log } from "../logger.js";
import * as queue from "./queue.js";
import { Stealth } from "./stealth/index.js";

const Client = pkg.Client || pkg.default?.Client;
const LocalAuth = pkg.LocalAuth || pkg.default?.LocalAuth;

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
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--hide-scrollbars",
  "--metrics-recording-only",
];

const withTimeout = (promise, ms, label) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout após ${ms}ms`)), ms);
  });
  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
};

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
    // Rate limit configurável (padrão 20 msg/min para evitar ban)
    const maxPerMinute = config.rateLimit?.maxPerMinute ?? 20;
    const intervalMs = Math.floor(60000 / maxPerMinute);
    this.rate = { maxPerMinute, intervalMs, sent: [], lastSend: 0 };
    this.stealth = new Stealth(config.stealth, this.index);
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
    const check = await this.stealth.beforeSend(phone, this.client);
    if (!check.allowed) {
      if (check.reason === "DAILY_LIMIT" || check.reason === "CONTACT_WINDOW" || check.reason === "OUT_OF_HOURS") {
        await queue.revertToPending(queueId, check.message);
        this._addLog("warn", check.message, { to: phone, queueId });
      }
      return { success: false, code: check.reason, error: check.message };
    }
    const msgVariada = this.stealth.content.variar(message);
    const result = await this._doSend(phone, msgVariada);
    if (result.success) {
      await queue.complete(queueId);
      this.stealth.afterSend(phone);
      this.storage?.addMessage({ to: phone, status: "sent", source: "api", account: this.index, metadata: JSON.stringify({ queueId }) });
    } else if (result.code === "RATE_LIMIT") {
      await queue.revertToPending(queueId, "rate_limit");
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
    this.rate.sent = this.rate.sent.filter((t) => now - t < 60000);
    if (this.rate.sent.length >= this.rate.maxPerMinute) {
      return this._fail("RATE_LIMIT", `Limite de ${this.rate.maxPerMinute} mensagens/minuto atingido.`);
    }
    const wait = this.rate.intervalMs - (now - this.rate.lastSend);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    let chatId = `${cleanNumber}@c.us`;
    try {
      // Verifica se o número existe no WhatsApp via queryWidExists
      // (consulta direta nos servidores do WhatsApp, não depende de contato na agenda)
      let registered = await withTimeout(
        this.client.getNumberId(cleanNumber),
        5000,
        "getNumberId"
      );

      // Retry único em caso de falha transiente
      if (registered === null) {
        await new Promise((r) => setTimeout(r, 1000));
        registered = await withTimeout(
          this.client.getNumberId(cleanNumber),
          5000,
          "getNumberId-retry"
        );
      }

      if (registered === null) {
        this._addLog("warn", "getNumberId retornou null em ambas tentativas — número não registrado no WhatsApp", { to: cleanNumber });
        return this._fail("NOT_REGISTERED", "Número não registrado no WhatsApp. Verifique se o número informado possui WhatsApp ativo.", cleanNumber);
      }

      const lid = typeof registered === "object" ? registered._serialized : (typeof registered === "string" ? registered : null);
      if (lid && lid.endsWith("@lid")) {
        this._addLog("warn", "getNumberId retornou LID, resolvendo chat via Store.Chat.find + openChatWindow", { to: cleanNumber, lid });
        try {
          const resolved = await withTimeout(
            this.client.pupPage.evaluate((number) => {
              const id = number + "@c.us";
              const chat = window.Store.Chat.get(id);
              if (chat) return chat.id._serialized;
              return window.Store.Chat.find(id).then(function(c) { return c.id._serialized; }).catch(function() { return id; });
            }, cleanNumber),
            5000,
            "resolveChat"
          );
          if (resolved) chatId = resolved;
          await withTimeout(this.client.interface.openChatWindow(chatId), 3000, "openChatWindow").catch(() => {});
        } catch (_) {
          this._addLog("warn", "Store.Chat.find/open falhou, mantendo @c.us", { to: cleanNumber });
        }
      } else if (lid) {
        chatId = lid;
      }

      const sent = await withTimeout(
        this.client.sendMessage(chatId, message),
        this.config.sendTimeoutMs,
        "sendMessage"
      );

      if (!sent) {
        this._addLog("message_error", "sendMessage retornou nulo", { to: cleanNumber });
        return this._fail("SEND_ERROR", "sendMessage retornou nulo — chat não encontrado.", cleanNumber);
      }

      this.lastSendAt = new Date().toISOString();
      this.rate.lastSend = Date.now();
      this.rate.sent.push(this.rate.lastSend);
      const messageId = sent?.id?._serialized || sent?.id || null;

      // Sincronização pós-envio — força o WhatsApp Web a sincronizar com o celular
      setImmediate(async () => {
        try {
          await withTimeout(this.client.interface.openChatWindow(chatId), 3000, "openChatWindow-post").catch(() => {});
        } catch (_) {}
        try {
          const chat = await this.client.getChatById(chatId);
          if (chat) {
            await chat.sendSeen().catch(() => {});
            await new Promise((r) => setTimeout(r, 800));
            await chat.sendPresenceAvailable().catch(() => {});
            await this.client.interface.openChatWindow(chatId).catch(() => {});
          }
        } catch (_) {}
        try {
          await this.client.getChats();
        } catch (_) {}
      });

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
      const result = await this._doSend(cleanNumber, this.stealth.content.variar(message));
      if (result.success) {
        this.storage?.addMessage({ to: cleanNumber, status: "sent", source: "api", id: result.messageId, account: this.index });
      }
      resolve(result);
    }

    this._processingQueue = false;
  }

  async _tryDequeue() {
    if (this._queueProcessing || !this.isReady() || this._destroyed) return;
    if (!this.stealth.multi.isHealthy()) return;
    if (this.stealth.enabled && !this.stealth.scheduler.isWithinBusinessHours()) return;
    
    // Rate limiting check
    const now = Date.now();
    const recent = this.rate.sent.filter((t) => now - t < 60000);
    if (recent.length >= this.rate.maxPerMinute) {
      return;
    }

    this._queueProcessing = true;
    try {
      const items = await queue.dequeue(1, this.index);
      for (const item of items) {
        if (this._destroyed || !this.isReady()) break;
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
    const POLL_INTERVAL = 5000; // Increased from 3000 to reduce DB load
    this._queueWorkerTimer = setInterval(() => this._tryDequeue(), POLL_INTERVAL);
    this._tryDequeue();
    log.info(`[${this.accountLabel}] Worker da fila iniciado (polling a cada ${POLL_INTERVAL}ms, rate: ${this.rate.maxPerMinute}/min)`);
  }

  async _stopQueueWorker() {
    if (this._queueWorkerTimer) {
      clearInterval(this._queueWorkerTimer);
      this._queueWorkerTimer = null;
    }
    // Wait for current processing to finish (max 30s)
    const start = Date.now();
    while (this._queueProcessing && Date.now() - start < 30000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (this._queueProcessing) {
      log.warn(`[${this.accountLabel}] Queue worker não finalizou a tempo no shutdown`);
    }
  }

  async drainQueue() {
    // Process remaining items in memory queue
    while (this._msgQueue.length > 0) {
      await this._processQueue();
      await new Promise(r => setTimeout(r, 100));
    }
    // Try to process pending queue items from DB
    while (this.isReady() && !this._destroyed) {
      const items = await queue.dequeue(1, this.index);
      if (!items.length) break;
      for (const item of items) {
        await this.sendFromQueue(item.id, item.phone, item.message);
      }
    }
  }

  async initialize() {
    if (this._destroyed) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        await this._destroyClientSafely();
        await this._cleanupChromiumLocks();
        const client = await this._createClient();
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

  async _createClient() {
    const puppeteer = { headless: true, args: [...PUPPETEER_ARGS], protocolTimeout: 120_000 };
    const cfg = await this.stealth.getPuppeteerConfig(puppeteer);
    return new Client({
      authStrategy: new LocalAuth({
        clientId: this.config.clientId + "-" + this.index,
        dataPath: this.config.authFolder,
      }),
      puppeteer: cfg,
    });
  }

  async _cleanupChromiumLocks() {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dirs = [
        path.join(this.config.sessionFolder, `session-${this.config.clientId}-${this.index}`),
        this.config.authFolder,
      ];
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        this._removeSingletonLocks(fs, path, dir);
        for (const sub of fs.readdirSync(dir)) {
          const subPath = path.join(dir, sub);
          if (fs.statSync(subPath).isDirectory()) {
            this._removeSingletonLocks(fs, path, subPath);
          }
        }
      }
    } catch {}
  }

  _removeSingletonLocks(fs, path, dir) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith("Singleton")) {
          const fp = path.join(dir, file);
          try { fs.unlinkSync(fp); } catch {}
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
      this.stealth.multi.markHealthy();
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
      if (this.stealth.multi.isBlockEvent(reason)) {
        this.stealth.multi.handleBlock(reason);
        this._setStatus(STATES.ERROR, `Conta bloqueada: ${reason}`);
      } else if (reason !== "LOGOUT") {
        this._scheduleAutoReconnect("disconnected");
      }
    });

    client.on("auth_failure", (msg) => {
      this._setStatus(STATES.AUTH_FAILURE, `Falha de autenticação: ${msg}`);
      log.error(`[${this.accountLabel}] Falha de autenticação`, { message: msg });
      this._addLog("auth_failure", `Falha de autenticação: ${msg}`, { message: msg });
      if (this.stealth.multi.isBlockEvent("", msg)) {
        this.stealth.multi.handleBlock(msg);
      } else {
        this._scheduleAutoReconnect("auth_failure", 5000);
      }
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
        const authDir = path.join(this.config.authFolder, `session-${this.config.clientId}-${this.index}`);
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
