# IIT GPIO PRO — WebSocket Relay Server

Servidor relay WebSocket para conectar el ESP32-S3 con la app móvil desde cualquier red.

---

## Arquitectura

```
ESP32-S3  ──wss://relay──►  Relay Server  ◄──wss://relay──  App móvil
           role=device                        role=client
           id=<deviceId>                      id=<deviceId>
```

---

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `8080` | Puerto del servidor |
| `RELAY_SECRET` | `cambiar_esta_clave` | Token compartido entre ESP32 y app |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` |
| `USE_TLS` | `false` | TLS propio (Railway maneja SSL automático) |

---

## Deploy en Railway

1. Fork o push este repo a GitHub
2. Ir a [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Seleccionar este repo
4. En **Variables** agregar:
   ```
   RELAY_SECRET=tu_clave_secreta
   PORT=8080
   ```
5. Railway genera la URL automáticamente — tipo `iit-relay.up.railway.app`

---

## Endpoints

| Endpoint | Descripción |
|----------|-------------|
| `GET /health` | Estado del servidor |
| `GET /api/rooms` | Dispositivos conectados |
| `WS /ws?id=X&role=device&token=Y` | Conexión ESP32 |
| `WS /ws?id=X&role=client&token=Y` | Conexión app |

---

## Deploy local

```bash
npm install
RELAY_SECRET=miclave node relay.js
```

---

## Autor

**Jairo Sepúlveda** — IIT (Infraestructura-IT) · Bogotá, Colombia · 2026
