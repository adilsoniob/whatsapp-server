/**
 * Configuração central do servidor.
 * Tudo que varia por ambiente fica aqui.
 *
 * IMPORTANTE: WHATSAPP_API_KEY tem dois nomes aceitos para compatibilidade:
 * - WHATSAPP_API_KEY (nome padrão/convenção)
 * - API_KEY (nome curto, comum em Railway/Render quando se tem só uma chave)
 */

export const config = {
  port: parseInt(process.env.PORT || "4320", 10),
  // Aceita ambos os nomes: WHATSAPP_API_KEY ou API_KEY (Railway)
  apiKey: process.env.WHATSAPP_API_KEY || process.env.API_KEY || "",
  clientId: process.env.WHATSAPP_CLIENT_ID || "vale-saude",
  logPrefix: process.env.LOG_PREFIX || "[whatsapp-svc]",
  // Timeout do envio de mensagem (evita travar requisições)
  sendTimeoutMs: parseInt(process.env.SEND_TIMEOUT_MS || "20000", 10),
  // Limite de tentativas de reconexão automática
  maxReconnectAttempts: parseInt(process.env.MAX_RECONNECT_ATTEMPTS || "5", 10),
  // Backoff inicial (multiplica a cada falha)
  reconnectBaseDelayMs: parseInt(process.env.RECONNECT_BASE_DELAY_MS || "8000", 10),
  // Pasta da sessão WhatsApp (suporta SESSION_FOLDER para Railway)
  sessionFolder: process.env.SESSION_FOLDER || "./data/session",
  // Número máximo de contas simultâneas
  maxAccounts: parseInt(process.env.MAX_ACCOUNTS || "1", 10),
};
