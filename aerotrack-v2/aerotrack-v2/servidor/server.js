'use strict';
/**
 * AeroTrack BR — Servidor de Aplicação
 *
 * Responsabilidades:
 *  1. Subscriber MQTT: consome telemetria e eventos dos aviões
 *  2. Agrega estado atual de cada voo em memória (stateful mínimo, reconstituível)
 *  3. WebSocket server: faz fan-out para clientes web em tempo real
 *  4. REST API: endpoints para histórico, status e métricas
 *  5. Persiste eventos no PostgreSQL (TimescaleDB-compatible)
 *
 * Conceitos de SD:
 *  - Subscriber desacoplado do publisher (aviões)
 *  - Estado reconstituível (stateless em relação ao broker)
 *  - Fan-out eficiente via WebSocket
 *  - Servidor multithread via cluster Node.js (opcional)
 */

const mqtt      = require('mqtt');
const WebSocket = require('ws');
const http      = require('http');
const { Pool }  = require('pg');

// ─── Configuração ─────────────────────────────────────────────────────────────
const CFG = {
  brokerUrl:  process.env.BROKER_URL  || 'mqtt://broker:1883',
  httpPort:   parseInt(process.env.HTTP_PORT || '4000'),
  dbUrl:      process.env.DATABASE_URL || 'postgresql://aerotrack:aerotrack@banco:5432/aerotrack',
  clientId:   `servidor_app_${Date.now()}`,
};

// ─── Estado em memória (reconstituível) ───────────────────────────────────────
// Chave: callsign → última telemetria conhecida
const flightState = new Map();
let   totalMsgs   = 0;
let   msgsPerSec  = 0;
let   msgsWindow  = 0;

setInterval(() => { msgsPerSec = msgsWindow; msgsWindow = 0; }, 1000);

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: CFG.dbUrl });

async function initDb() {
  const client = await db.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetria (
        id          BIGSERIAL PRIMARY KEY,
        callsign    VARCHAR(16) NOT NULL,
        airline     VARCHAR(64),
        origin      VARCHAR(4),
        destination VARCHAR(4),
        lat         DOUBLE PRECISION,
        lng         DOUBLE PRECISION,
        altitude    INTEGER,
        speed       INTEGER,
        heading     INTEGER,
        phase       VARCHAR(16),
        progress    DOUBLE PRECISION,
        ts          BIGINT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS eventos (
        id         BIGSERIAL PRIMARY KEY,
        callsign   VARCHAR(16) NOT NULL,
        evento     VARCHAR(32) NOT NULL,
        payload    JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Índices para consultas por voo e tempo
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tel_callsign ON telemetria(callsign);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tel_ts       ON telemetria(ts);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_evt_callsign ON eventos(callsign);`);
    console.log('[SERVIDOR] ✓ Banco de dados inicializado');
  } catch (err) {
    console.error('[SERVIDOR] Erro ao inicializar banco:', err.message);
  } finally {
    client.release();
  }
}

async function persistTelemetria(data) {
  try {
    await db.query(
      `INSERT INTO telemetria (callsign,airline,origin,destination,lat,lng,altitude,speed,heading,phase,progress,ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [data.callsign, data.airline, data.origin, data.destination,
       data.lat, data.lng, data.altitude, data.speed, data.heading,
       data.phase, data.progress, data.ts]
    );
  } catch (err) {
    console.error('[SERVIDOR] Erro ao persistir telemetria:', err.message);
  }
}

async function persistEvento(callsign, evento, payload) {
  try {
    await db.query(
      `INSERT INTO eventos (callsign, evento, payload) VALUES ($1,$2,$3)`,
      [callsign, evento, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error('[SERVIDOR] Erro ao persistir evento:', err.message);
  }
}

// ─── WebSocket Server (fan-out para browsers) ─────────────────────────────────
const httpServer = http.createServer(handleHttp);
const wss = new WebSocket.Server({ server: httpServer });

const wsClients = new Set();

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  console.log(`[SERVIDOR] + Cliente WS conectado | total=${wsClients.size}`);

  // Enviar estado atual de todos os voos ao novo cliente (snapshot)
  const snapshot = {
    type:    'SNAPSHOT',
    flights: Object.fromEntries(flightState),
    metrics: getMetrics(),
    ts:      Date.now(),
  };
  ws.send(JSON.stringify(snapshot));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[SERVIDOR] - Cliente WS desconectado | total=${wsClients.size}`);
  });

  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  });
}

// ─── MQTT Subscriber ──────────────────────────────────────────────────────────
const mqttClient = mqtt.connect(CFG.brokerUrl, {
  clientId:        CFG.clientId,
  clean:           true,
  reconnectPeriod: 3000,
});

mqttClient.on('connect', () => {
  console.log('[SERVIDOR] ✓ Conectado ao broker MQTT');

  // Subscrever toda telemetria: voo/{airline}/{callsign}/telemetria
  mqttClient.subscribe('voo/+/+/telemetria', { qos: 0 });
  // Subscrever todos os eventos de ciclo de vida
  mqttClient.subscribe('voo/eventos', { qos: 1 });

  console.log('[SERVIDOR] Subscrito: voo/+/+/telemetria | voo/eventos');
});

mqttClient.on('message', (topic, message) => {
  totalMsgs++;
  msgsWindow++;

  let payload;
  try { payload = JSON.parse(message.toString()); }
  catch { return; }

  if (topic === 'voo/eventos') {
    handleEvento(payload);
    return;
  }

  if (topic.endsWith('/telemetria')) {
    handleTelemetria(payload);
  }
});

mqttClient.on('reconnect', () => console.log('[SERVIDOR] Reconectando ao broker MQTT...'));
mqttClient.on('error', (err) => console.error('[SERVIDOR] Erro MQTT:', err.message));

// Persistir telemetria a cada N ticks para não sobrecarregar o banco
// (evita write amplification — guarda 1 de cada 10 posições)
const PERSIST_EVERY = 10;
const persistCounters = new Map();

function handleTelemetria(data) {
  const cs = data.callsign;
  flightState.set(cs, data);

  // Fan-out para browsers
  broadcast({ type: 'TELEMETRIA', payload: data, ts: Date.now() });

  // Persistência amostrada
  const cnt = (persistCounters.get(cs) || 0) + 1;
  persistCounters.set(cs, cnt);
  if (cnt % PERSIST_EVERY === 0) {
    persistTelemetria(data);
  }
}

function handleEvento(data) {
  const cs = data.callsign || 'unknown';
  console.log(`[SERVIDOR] Evento: ${data.evento} | ${cs}`);

  if (data.evento === 'pousou' || data.evento === 'desconectou') {
    flightState.delete(cs);
    persistCounters.delete(cs);
  }

  broadcast({ type: 'EVENTO', payload: data, ts: Date.now() });
  persistEvento(cs, data.evento, data);
}

// ─── REST API ─────────────────────────────────────────────────────────────────
function getMetrics() {
  return {
    voosAtivos:   flightState.size,
    totalMsgs,
    msgsPerSec,
    wsClients:    wsClients.size,
    uptime:       process.uptime(),
    memMb:        Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

function handleHttp(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = req.url.split('?')[0];

  // GET /status — métricas do servidor
  if (url === '/status') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', ...getMetrics() }, null, 2));
  }

  // GET /voos — estado atual de todos os voos
  if (url === '/voos') {
    res.writeHead(200);
    return res.end(JSON.stringify(Object.fromEntries(flightState), null, 2));
  }

  // GET /voos/:callsign — estado de um voo específico
  const voosMatch = url.match(/^\/voos\/([A-Z0-9]+)$/);
  if (voosMatch) {
    const cs = voosMatch[1];
    const flight = flightState.get(cs);
    if (!flight) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Voo não encontrado' })); }
    res.writeHead(200);
    return res.end(JSON.stringify(flight, null, 2));
  }

  // GET /historico/:callsign — últimas 100 posições do banco
  const histMatch = url.match(/^\/historico\/([A-Z0-9]+)$/);
  if (histMatch) {
    const cs = histMatch[1];
    db.query(
      `SELECT lat, lng, altitude, speed, heading, phase, ts
       FROM telemetria WHERE callsign=$1 ORDER BY ts DESC LIMIT 100`,
      [cs]
    ).then(result => {
      res.writeHead(200);
      res.end(JSON.stringify({ callsign: cs, points: result.rows }));
    }).catch(err => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // GET /eventos — últimos 50 eventos
  if (url === '/eventos') {
    db.query(`SELECT callsign, evento, payload, created_at FROM eventos ORDER BY id DESC LIMIT 50`)
      .then(result => {
        res.writeHead(200);
        res.end(JSON.stringify(result.rows));
      }).catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Rota não encontrada' }));
}

// ─── Inicialização ────────────────────────────────────────────────────────────
async function main() {
  // Aguardar banco ficar disponível
  let dbOk = false;
  for (let i = 0; i < 10; i++) {
    try {
      await db.query('SELECT 1');
      dbOk = true;
      break;
    } catch {
      console.log(`[SERVIDOR] Aguardando banco... tentativa ${i+1}/10`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (!dbOk) {
    console.error('[SERVIDOR] Banco indisponível após 10 tentativas. Continuando sem persistência.');
  } else {
    await initDb();
  }

  httpServer.listen(CFG.httpPort, '0.0.0.0', () => {
    console.log(`[SERVIDOR] HTTP/WebSocket na porta ${CFG.httpPort}`);
    console.log(`[SERVIDOR] REST: http://localhost:${CFG.httpPort}/status`);
    console.log(`[SERVIDOR] WS:   ws://localhost:${CFG.httpPort}`);
  });
}

main().catch(err => { console.error('[SERVIDOR] Erro fatal:', err); process.exit(1); });

process.on('SIGTERM', () => {
  console.log('[SERVIDOR] SIGTERM — encerrando conexões.');
  mqttClient.end();
  httpServer.close(() => process.exit(0));
});
