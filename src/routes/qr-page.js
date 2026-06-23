/**
 * Página HTML do QR Code (acessível em /).
 * Mostra o status em tempo real via polling + socket.
 */

import { Router } from "express";

export const qrPageRouter = Router();

const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp | Vale Saúde</title>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0a0f1c;
  --bg-gradient: radial-gradient(circle at top center, #16203d 0%, #0a0f1c 100%);
  --card: rgba(21, 31, 53, 0.7);
  --card-border: rgba(30, 45, 74, 0.8);
  --text-main: #f8fafc;
  --text-muted: #94a3b8;
  --accent: #3b82f6;
  --accent-glow: rgba(59, 130, 246, 0.5);
  --success: #22c55e;
  --success-bg: rgba(34, 197, 94, 0.1);
  --warning: #eab308;
  --warning-bg: rgba(234, 179, 8, 0.1);
  --error: #ef4444;
  --error-bg: rgba(239, 68, 68, 0.1);
  --border-color: rgba(51, 65, 85, 0.5);
  --shadow-premium: 0 20px 50px rgba(0, 0, 0, 0.5);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background: var(--bg);
  background-image: var(--bg-gradient);
  color: var(--text-main);
  overflow: hidden;
}

/* Background Decorative Elements */
body::before, body::after {
  content: "";
  position: absolute;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  background: var(--accent);
  filter: blur(120px);
  opacity: 0.15;
  z-index: -1;
}
body::before { top: -100px; left: -100px; }
body::after { bottom: -100px; right: -100px; }

.qr-wrap {
  text-align: center;
  padding: 3rem 2rem;
  max-width: 440px;
  width: 90%;
  animation: fadeUp 0.8s ease-out;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.logo {
  margin-bottom: 2rem;
  display: inline-flex;
  padding: 1rem;
  background: rgba(59, 130, 246, 0.1);
  border-radius: 20px;
  border: 1px solid rgba(59, 130, 246, 0.2);
  box-shadow: 0 0 20px rgba(59, 130, 246, 0.1);
}

.logo svg {
  width: 48px;
  height: 48px;
  filter: drop-shadow(0 0 8px var(--accent));
}

h1 {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  margin-bottom: 0.5rem;
  background: linear-gradient(to bottom, #fff 0%, #cbd5e1 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.sub {
  font-size: 0.95rem;
  color: var(--text-muted);
  margin-bottom: 2.5rem;
  line-height: 1.5;
}

.qr-box {
  background: var(--card);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: 24px;
  padding: 2rem;
  border: 1px solid var(--card-border);
  position: relative;
  min-height: 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-premium);
  transition: transform 0.3s ease;
}

.qr-box:hover {
  transform: translateY(-5px);
}

#qr {
  width: 240px;
  height: 240px;
  border-radius: 16px;
  background: #fff;
  padding: 12px;
  display: none;
  transition: opacity 0.4s ease;
  box-shadow: 0 0 30px rgba(255, 255, 255, 0.1);
}

.qr-placeholder {
  width: 240px;
  height: 240px;
  border-radius: 16px;
  background: rgba(30, 45, 74, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--border-color);
  transition: all 0.3s ease;
}

.qr-placeholder svg {
  width: 64px;
  height: 64px;
  opacity: 0.2;
}

.status {
  margin-top: 2rem;
  padding: 0.75rem 1.25rem;
  border-radius: 12px;
  font-weight: 500;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border: 1px solid transparent;
}

.st-ok {
  background: var(--success-bg);
  color: var(--success);
  border-color: rgba(34, 197, 94, 0.3);
}

.st-await {
  background: var(--warning-bg);
  color: var(--warning);
  border-color: rgba(234, 179, 8, 0.3);
}

.st-off {
  background: rgba(148, 163, 184, 0.1);
  color: var(--text-muted);
  border-color: rgba(148, 163, 184, 0.2);
}

.spin {
  display: inline-block;
  width: 18px;
  height: 18px;
  border: 2px solid rgba(148, 163, 184, 0.2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin { to { transform: rotate(360deg); } }

.actions {
  margin-top: 2.5rem;
  display: flex;
  gap: 1rem;
  justify-content: center;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1.25rem;
  border-radius: 10px;
  border: none;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
  font-family: inherit;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 4px 12px var(--accent-glow);
}

.btn-primary:hover {
  filter: brightness(1.1);
  transform: translateY(-2px);
  box-shadow: 0 6px 20px var(--accent-glow);
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
}

.btn-outline:hover {
  border-color: var(--text-main);
  color: var(--text-main);
  background: rgba(255, 255, 255, 0.05);
  transform: translateY(-2px);
}

.footer {
  margin-top: 3rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  opacity: 0.6;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

@media(max-width:480px){
  .qr-wrap { padding: 2rem 1.5rem; }
  h1 { font-size: 1.5rem; }
  #qr, .qr-placeholder { width: 200px; height: 200px; }
  .qr-box { padding: 1.5rem; min-height: 320px; }
}
</style>
</head>
<body>
<div class="qr-wrap">
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  </div>
  <h1>Conectar WhatsApp</h1>
  <p class="sub">Escaneie o QR Code com o seu celular para sincronizar a conta</p>

  <div class="qr-box">
    <img id="qr" src="" alt="QR Code">
    <div class="qr-placeholder" id="placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>
      </svg>
    </div>

    <div id="st" class="status st-off">
      <span class="spin"></span> Inicializando servidor...
    </div>
  </div>

  <div class="actions">
    <a href="/admin" class="btn btn-outline">Painel Administrativo</a>
  </div>

  <div class="footer">WhatsApp Server &bull; Vale Saúde</div>
</div>

<script>
(function(){
  var st = document.getElementById("st");
  var qr = document.getElementById("qr");
  var placeholder = document.getElementById("placeholder");
  var lastQr = "";
  var pollId = null;

  function setAwait(msg) {
    qr.style.display = "";
    placeholder.style.display = "none";
    st.className = "status st-await";
    st.innerHTML = msg;
  }
  function setOk(msg) {
    qr.style.display = "none";
    placeholder.style.display = "flex";
    st.className = "status st-ok";
    st.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ' + msg;
  }
  function setOff(msg) {
    qr.style.display = "none";
    placeholder.style.display = "flex";
    st.className = "status st-off";
    st.innerHTML = '<span class="spin"></span> ' + msg;
  }

  function applyState(s) {
    if (s.status === "connected") return setOk("Conectado!");
    if (s.qr && s.qr !== lastQr) {
      lastQr = s.qr;
      qr.src = s.qr;
      return setAwait("QR Code gerado. Escaneie com seu WhatsApp.");
    }
    if (s.status === "starting" || s.status === "reconnecting") return setOff("Inicializando servidor...");
    if (s.status === "auth_failure") return setOff("Falha de autenticação. Reconectando...");
    if (s.status === "offline") return setOff("Desconectado.");
    return setOff(s.message || "Aguardando...");
  }

  function poll() {
    fetch("/api/whatsapp/status", { cache: "no-store" })
      .then(function(r) { return r.json(); })
      .then(applyState)
      .catch(function() { return setOff("Aguardando servidor..."); })
      .finally(function() { pollId = setTimeout(poll, 2500); });
  }

  try {
    var sock = io({ transports: ["websocket","polling"], reconnection: true });
    sock.on("qr", function(d) {
      if (d.qrDataUrl && d.qrDataUrl !== lastQr) {
        lastQr = d.qrDataUrl;
        qr.src = d.qrDataUrl;
        setAwait("QR Code gerado. Escaneie com seu WhatsApp.");
      }
    });
    sock.on("connected", function() { return setOk("Conectado!"); });
    sock.on("disconnected", function() { return setOff("WhatsApp desconectado."); });
    sock.on("connect_error", function() { if (!pollId) poll(); });
  } catch(e) {}

  poll();
})();
</script>
</body>
</html>`;

qrPageRouter.get("/", (_req, res) => {
  res.type("html").send(HTML);
});
