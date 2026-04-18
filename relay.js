/**
 * ESP32 GPIO PRO — WebSocket Relay Server
 * ─────────────────────────────────────────
 * El ESP32 se conecta como "device"
 * El navegador/app se conecta como "client"
 * El relay los empareja por deviceId
 *
 * URL device: ws://servidor:PORT/ws?id=DEVICE_ID&role=device&token=SECRET
 * URL client: ws://servidor:PORT/ws?id=DEVICE_ID&role=client&token=SECRET
 *
 * Página de control:  http://servidor:PORT/control?id=DEVICE_ID
 */

const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const url        = require('url');
const crypto     = require('crypto');

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────
const CONFIG = {
  PORT:        process.env.PORT        || 8080,
  SECRET:      process.env.RELAY_SECRET || 'cambiar_esta_clave',
  USE_TLS:     process.env.USE_TLS     === 'true',
  CERT_PATH:   process.env.CERT_PATH   || '/etc/letsencrypt/live/tudominio.com/fullchain.pem',
  KEY_PATH:    process.env.KEY_PATH    || '/etc/letsencrypt/live/tudominio.com/privkey.pem',
  PING_INTERVAL: 20000,    // ms entre pings a los clientes
  MAX_CLIENTS:   10,       // max clientes por device
  LOG_LEVEL:     process.env.LOG_LEVEL || 'info',  // debug | info | warn
};

// ── ESTADO ────────────────────────────────────────────────────────────────
// rooms[deviceId] = { device: WS|null, clients: [WS,...], lastSeen: Date }
const rooms = {};
let totalConnections = 0;

// ── LOGGING ───────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().substring(11,23); }
function log(level, msg) {
  const levels = { debug:0, info:1, warn:2, error:3 };
  if (levels[level] >= levels[CONFIG.LOG_LEVEL]) {
    const colors = { debug:'\x1b[36m', info:'\x1b[32m', warn:'\x1b[33m', error:'\x1b[31m' };
    console.log(`${colors[level]}[${ts()}] [${level.toUpperCase()}]\x1b[0m ${msg}`);
  }
}

// ── AUTENTICACIÓN ─────────────────────────────────────────────────────────
function verifyToken(deviceId, token) {
  if (!CONFIG.SECRET || CONFIG.SECRET === '') return true; // sin auth
  if (!token) return false;
  // Token válido = el token configurado directamente, O
  // HMAC-SHA256(secret + deviceId) en hex (para tokens por dispositivo)
  if (token === CONFIG.SECRET) return true;
  const expected = crypto.createHmac('sha256', CONFIG.SECRET)
                         .update(deviceId).digest('hex').substring(0, 16);
  return token === expected;
}

// ── SERVIDOR HTTP ─────────────────────────────────────────────────────────
function requestHandler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Página de control embebida
  if (pathname === '/control') {
    const id = parsed.query.id || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildControlPage(id));
    return;
  }

  // API estado de rooms
  if (pathname === '/api/rooms') {
    const summary = {};
    for (const [id, room] of Object.entries(rooms)) {
      summary[id] = {
        deviceOnline: room.device !== null,
        clients:      room.clients.length,
        lastSeen:     room.lastSeen
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: Object.keys(rooms).length, connections: totalConnections }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ── SERVIDOR ──────────────────────────────────────────────────────────────
let server;
if (CONFIG.USE_TLS && fs.existsSync(CONFIG.CERT_PATH)) {
  const tlsOpts = {
    cert: fs.readFileSync(CONFIG.CERT_PATH),
    key:  fs.readFileSync(CONFIG.KEY_PATH),
  };
  server = https.createServer(tlsOpts, requestHandler);
  log('info', `Modo TLS activado`);
} else {
  server = http.createServer(requestHandler);
}

const wss = new WebSocket.Server({ server, path: '/ws' });

// ── WEBSOCKET ─────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const params   = new URLSearchParams(url.parse(req.url).query);
  const id       = params.get('id')    || '';
  const role     = params.get('role')  || 'client';
  const token    = params.get('token') || '';
  const clientIp = req.socket.remoteAddress;

  // Validar parámetros
  if (!id) {
    log('warn', `Conexión sin id desde ${clientIp} — rechazada`);
    ws.close(4001, 'id requerido');
    return;
  }

  // Verificar token
  if (!verifyToken(id, token)) {
    log('warn', `Token inválido para device ${id} desde ${clientIp}`);
    ws.close(4003, 'Token inválido');
    return;
  }

  // Crear room si no existe
  if (!rooms[id]) rooms[id] = { device: null, clients: [], lastSeen: null };
  const room = rooms[id];
  totalConnections++;

  // ── DEVICE (ESP32) ───────────────────────────────────────────────────
  if (role === 'device') {
    // Desconectar device anterior si existe
    if (room.device && room.device.readyState === WebSocket.OPEN) {
      room.device.close(4000, 'Nueva conexión del mismo device');
    }
    room.device   = ws;
    room.lastSeen = new Date().toISOString();
    log('info', `[${id}] Device CONECTADO desde ${clientIp}`);

    // Notificar a clientes que el device está online
    broadcastToClients(id, { type: 'status', online: true, deviceId: id }, null);

    ws.on('message', (raw) => {
      room.lastSeen = new Date().toISOString();
      log('debug', `[${id}] Device → Clients: ${raw.toString().substring(0,80)}`);
      // Reenviar estado a todos los clientes
      broadcastToClients(id, raw.toString(), null);
    });

    ws.on('close', (code) => {
      totalConnections--;
      if (room.device === ws) room.device = null;
      log('info', `[${id}] Device DESCONECTADO (code: ${code})`);
      broadcastToClients(id, { type: 'status', online: false, deviceId: id }, null);
      cleanRoom(id);
    });

    ws.on('error', (err) => {
      log('warn', `[${id}] Device error: ${err.message}`);
    });

  // ── CLIENT (navegador / app) ─────────────────────────────────────────
  } else {
    // Limitar clientes por room
    if (room.clients.length >= CONFIG.MAX_CLIENTS) {
      log('warn', `[${id}] Room llena (${CONFIG.MAX_CLIENTS} clientes)`);
      ws.close(4002, 'Room llena');
      return;
    }

    room.clients.push(ws);
    log('info', `[${id}] Client CONECTADO desde ${clientIp} (total: ${room.clients.length})`);

    // Informar al cliente el estado actual del device
    const online = room.device !== null && room.device.readyState === WebSocket.OPEN;
    sendJSON(ws, { type: 'status', online, deviceId: id });

    // Si el device está online, pedirle el estado actual
    if (online) {
      sendRaw(room.device, JSON.stringify({ cmd: 'state' }));
    }

    ws.on('message', (raw) => {
      log('debug', `[${id}] Client → Device: ${raw.toString().substring(0,80)}`);
      // Reenviar comando al device
      if (room.device && room.device.readyState === WebSocket.OPEN) {
        room.device.send(raw.toString());
      } else {
        sendJSON(ws, { type: 'error', msg: 'Device offline' });
      }
    });

    ws.on('close', () => {
      totalConnections--;
      room.clients = room.clients.filter(c => c !== ws);
      log('info', `[${id}] Client DESCONECTADO (quedan: ${room.clients.length})`);
      cleanRoom(id);
    });

    ws.on('error', (err) => {
      log('warn', `[${id}] Client error: ${err.message}`);
    });
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────
function sendJSON(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
}

function sendRaw(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function broadcastToClients(id, msg, exclude) {
  const room = rooms[id];
  if (!room) return;
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  room.clients.forEach(c => {
    if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(data);
  });
}

function cleanRoom(id) {
  const room = rooms[id];
  if (!room) return;
  if (!room.device && room.clients.length === 0) {
    delete rooms[id];
    log('debug', `[${id}] Room eliminada`);
  }
}

// ── PING para mantener conexiones vivas ───────────────────────────────────
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  });
}, CONFIG.PING_INTERVAL);

// ── PÁGINA DE CONTROL EMBEBIDA ────────────────────────────────────────────
function buildControlPage(deviceId) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPIO PRO — Control Remoto</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#03050a;color:#c8d8e8;font-family:'Segoe UI',sans-serif;
       display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:20px}
  h1{font-size:1.2rem;letter-spacing:.1em;color:#00ffe0;margin-bottom:6px}
  .sub{font-size:.7rem;color:rgba(200,216,232,.4);letter-spacing:.15em;margin-bottom:20px}
  .status{display:flex;align-items:center;gap:8px;padding:8px 16px;border-radius:20px;
          border:1px solid rgba(255,255,255,.1);margin-bottom:20px;font-size:.75rem}
  .dot{width:10px;height:10px;border-radius:50%;background:#ff4466}
  .dot.on{background:#39ff14;box-shadow:0 0 8px #39ff14}
  .dot.warn{background:#ffd166}
  .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
        border-radius:10px;padding:16px;margin-bottom:12px;width:100%;max-width:400px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .pin-btn{background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.1);
           border-radius:8px;padding:12px 8px;cursor:pointer;transition:all .2s;
           color:rgba(200,216,232,.5);font-size:.65rem;text-align:center}
  .pin-btn.on{background:rgba(57,255,20,.1);border-color:rgba(57,255,20,.3);color:#39ff14}
  .pin-btn:hover{border-color:rgba(255,255,255,.25)}
  .pin-num{font-size:1rem;font-weight:700;margin-bottom:3px}
  .log{background:rgba(0,0,0,.4);border-radius:6px;padding:10px;font-size:.6rem;
       font-family:monospace;height:120px;overflow-y:auto;color:rgba(200,216,232,.4)}
  .btn{padding:8px 20px;border:1px solid;border-radius:5px;cursor:pointer;
       font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;transition:all .2s}
  .bc{background:rgba(0,255,224,.08);color:#00ffe0;border-color:rgba(0,255,224,.3)}
  .br{background:rgba(255,68,102,.08);color:#ff4466;border-color:rgba(255,68,102,.3)}
  .row{display:flex;gap:8px;margin-top:12px}
</style>
</head>
<body>
<h1>&#9889; GPIO PRO</h1>
<div class="sub">CONTROL REMOTO — RELAY</div>
<div class="status">
  <div class="dot warn" id="dot"></div>
  <span id="stxt">Conectando...</span>
</div>

<div class="card">
  <div style="font-size:.6rem;color:rgba(200,216,232,.3);letter-spacing:.1em;margin-bottom:10px">OUTPUTS — CLICK PARA TOGGLE</div>
  <div class="grid" id="pinGrid"></div>
  <div class="row">
    <button class="btn bc" onclick="sendCmd({cmd:'state'})">ACTUALIZAR</button>
    <button class="btn br" onclick="sendCmd({cmd:'off_all'})">TODO OFF</button>
  </div>
</div>

<div class="card">
  <div style="font-size:.6rem;color:rgba(200,216,232,.3);letter-spacing:.1em;margin-bottom:8px">LOG</div>
  <div class="log" id="log">Conectando al relay...<br></div>
</div>

<script>
var WS_HOST  = window.location.host;
var DEVICE_ID = "${deviceId}";
var ws, pins={}, online=false;

function addLog(msg){ var l=document.getElementById("log"); l.innerHTML+=msg+"<br>"; l.scrollTop=l.scrollHeight; }
function setStatus(connected){
  online=connected;
  var dot=document.getElementById("dot");
  var stxt=document.getElementById("stxt");
  dot.className="dot"+(connected?" on":" ");
  stxt.textContent=connected?"Device conectado":"Device offline";
}

function sendCmd(obj){
  if(ws && ws.readyState===1) ws.send(JSON.stringify(obj));
}

function togglePin(idx){
  var cur=pins[idx]||0;
  sendCmd({cmd: cur?"off":"on", pin:idx});
}

function buildGrid(state){
  var grid=document.getElementById("pinGrid");
  grid.innerHTML="";
  if(!state||!state.pins) return;
  state.pins.forEach(function(p,i){
    if(p.mode==="OUTPUT"){
      pins[i]=p.value;
      var d=document.createElement("div");
      d.className="pin-btn"+(p.value?" on":"");
      d.innerHTML="<div class=\\"pin-num\\">GPIO "+p.pin+"</div><div>"+(p.name||"Pin "+(i+1))+"</div><div>"+(p.value?"HIGH":"LOW")+"</div>";
      d.onclick=(function(idx){ return function(){ togglePin(idx); }; })(i);
      grid.appendChild(d);
    }
  });
}

function connect(){
  var proto=location.protocol==="https:"?"wss:":"ws:";
  ws=new WebSocket(proto+"//"+WS_HOST+"/ws?id="+DEVICE_ID+"&role=client");
  ws.onopen=function(){ addLog("Conectado al relay"); };
  ws.onclose=function(){ setStatus(false); addLog("Desconectado — reintentando..."); setTimeout(connect,3000); };
  ws.onmessage=function(e){
    try{
      var d=JSON.parse(e.data);
      if(d.type==="status"){ setStatus(d.online); return; }
      if(d.pins){ buildGrid(d); }
    } catch(err){}
    addLog(e.data.substring(0,80));
  };
}
connect();
</script>
</body>
</html>`;
}

// ── ARRANCAR ──────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  log('info', `╔════════════════════════════════════════╗`);
  log('info', `║  ESP32 GPIO PRO — WebSocket Relay      ║`);
  log('info', `╚════════════════════════════════════════╝`);
  log('info', `Puerto    : ${CONFIG.PORT}`);
  log('info', `TLS       : ${CONFIG.USE_TLS}`);
  log('info', `Secret    : ${CONFIG.SECRET ? '****' : '(sin auth)'}`);
  log('info', `Health    : http://localhost:${CONFIG.PORT}/health`);
  log('info', `API rooms : http://localhost:${CONFIG.PORT}/api/rooms`);
});
