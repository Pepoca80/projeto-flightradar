'use strict';
/**
 * AeroTrack BR — Servidor de Aplicação
 *
 * Responsabilidades:
 *  1. Subscriber MQTT (Dinâmico via GeoDNS): consome telemetria e eventos
 *  2. Agrega estado atual de cada voo em memória
 *  3. WebSocket server: faz distribuição para clientes web em tempo real
 *  4. REST API: endpoints para histórico, status e métricas
 *  5. Persiste eventos no Apache Cassandra
 */

const mqtt      = require('mqtt');
const WebSocket = require('ws');
const http      = require('http');
const cassandra = require('cassandra-driver');

// ─── Configuração ─────────────────────────────────────────────────────────────
const CFG = {
  httpPort:   parseInt(process.env.HTTP_PORT || '4000'),
  clientId:   `servidor_app_${Date.now()}`,
  dbContact:  process.env.CASSANDRA_CONTACT_POINTS || 'banco',
  dbDc:       process.env.CASSANDRA_DATACENTER || 'datacenter1',
  dbKeyspace: process.env.CASSANDRA_KEYSPACE || 'usp_airlines',
  geoDnsUrl:  process.env.GEODNS_URL || 'http://geodns:8080',
  lat:        process.env.SERVER_LAT || '-23.5505',
  lon:        process.env.SERVER_LON || '-46.6333'
};

// ─── Estado em memória (reconstituível) ───────────────────────────────────────
const flightState = new Map();
let   totalMsgs   = 0;
let   msgsPerSec  = 0;
let   msgsWindow  = 0;

setInterval(() => { msgsPerSec = msgsWindow; msgsWindow = 0; }, 1000);

// ─── Apache Cassandra ─────────────────────────────────────────────────────────
const dbClient = new cassandra.Client({
  contactPoints: [CFG.dbContact],
  localDataCenter: CFG.dbDc,
  keyspace: CFG.dbKeyspace
});

async function initDb() {
  const setupClient = new cassandra.Client({
    contactPoints: [CFG.dbContact],
    localDataCenter: CFG.dbDc
  });

  try {
    await setupClient.connect();
    
    await setupClient.execute(`
      CREATE KEYSPACE IF NOT EXISTS ${CFG.dbKeyspace}
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
    `);

    await setupClient.execute(`
      CREATE TABLE IF NOT EXISTS ${CFG.dbKeyspace}.telemetria_by_callsign (
        callsign    text,
        ts          bigint,
        id          timeuuid,
        airline     text,
        origin      text,
        destination text,
        lat         double,
        lng         double,
        altitude    int,
        speed       int,
        heading     int,
        phase       text,
        progress    double,
        created_at  timestamp,
        PRIMARY KEY ((callsign), ts, id)
      ) WITH CLUSTERING ORDER BY (ts DESC, id DESC);
    `);

    await setupClient.execute(`
      CREATE TABLE IF NOT EXISTS ${CFG.dbKeyspace}.eventos_latest (
        bucket      text,
        created_at  timestamp,
        id          timeuuid,
        callsign    text,
        evento      text,
        payload     text,
        PRIMARY KEY ((bucket), created_at, id)
      ) WITH CLUSTERING ORDER BY (created_at DESC, id DESC);
    `);
    
    console.log('[SERVIDOR] ✓ Banco de dados inicializado com sucesso');
  } catch (err) {
    console.error('[SERVIDOR] Erro ao inicializar banco:', err.message);
  } finally {
    await setupClient.shutdown();
  }
}

async function persistTelemetria(data) {
  const query = `
    INSERT INTO telemetria_by_callsign 
    (callsign, ts, id, airline, origin, destination, lat, lng, altitude, speed, heading, phase, progress, created_at)
    VALUES (?, ?, now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))
  `;
  const params = [
    data.callsign, data.ts, data.airline, data.origin, data.destination,
    data.lat, data.lng, data.altitude, data.speed, data.heading,
    data.phase, data.progress
  ];

  try {
    await dbClient.execute(query, params, { prepare: true });
  } catch (err) {
    console.error('[SERVIDOR] Erro ao persistir telemetria:', err.message);
  }
}

async function persistEvento(callsign, evento, payload) {
  const query = `
    INSERT INTO eventos_latest (bucket, created_at, id, callsign, evento, payload)
    VALUES ('eventos', toTimestamp(now()), now(), ?, ?, ?)
  `;
  const params = [callsign, evento, JSON.stringify(payload)];

  try {
    await dbClient.execute(query, params, { prepare: true });
  } catch (err) {
    console.error('[SERVIDOR] Erro ao persistir evento:', err.message);
  }
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const httpServer = http.createServer(handleHttp);
const wss = new WebSocket.Server({ server: httpServer });

const wsClients = new Set();

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  console.log(`[SERVIDOR] + Cliente WS conectado | total=${wsClients.size}`);

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

// ─── MQTT Subscriber Inteligente via GeoDNS ───────────────────────────────────
let mqttClient = null;

async function obterRotaGeoDns() {
  try {
    const resposta = await fetch(`${CFG.geoDnsUrl}/resolver?lat=${CFG.lat}&lon=${CFG.lon}`);
    const dados = await resposta.json();
    return dados.brokerUrl;
  } catch (erro) {
    console.error('[SERVIDOR] Erro ao consultar a API do GeoDNS:', erro);
    return null;
  }
}

async function iniciarConexaoMqtt() {
  if (mqttClient) {
    mqttClient.end();
  }

  const brokerUrl = await obterRotaGeoDns();

  if (!brokerUrl) {
    console.log('[SERVIDOR] Falha ao obter rota. Tentando novamente em 5 segundos...');
    setTimeout(iniciarConexaoMqtt, 5000);
    return;
  }

  console.log(`[SERVIDOR] Rota encontrada. Iniciando conexao MQTT via GeoDNS: ${brokerUrl}`);

  mqttClient = mqtt.connect(brokerUrl, {
    clientId: CFG.clientId,
    clean: true,
    reconnectPeriod: 0, 
  });

  mqttClient.on('connect', () => {
    console.log('[SERVIDOR] ✓ Conectado ao broker MQTT com sucesso');
    mqttClient.subscribe('voo/+/+/telemetria', { qos: 0 });
    mqttClient.subscribe('voo/eventos', { qos: 1 });
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

  mqttClient.on('offline', () => {
    console.warn('[SERVIDOR] Broker offline. Solicitando rota alternativa ao GeoDNS em 3 segundos...');
    setTimeout(iniciarConexaoMqtt, 3000);
  });

  mqttClient.on('error', (err) => {
    console.error('[SERVIDOR] Erro na conexao MQTT:', err.message);
  });
}

const PERSIST_EVERY = 10;
const persistCounters = new Map();

function handleTelemetria(data) {
  const cs = data.callsign;
  flightState.set(cs, data);

  broadcast({ type: 'TELEMETRIA', payload: data, ts: Date.now() });

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

  if (url === '/status') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', ...getMetrics() }, null, 2));
  }

  if (url === '/voos') {
    res.writeHead(200);
    return res.end(JSON.stringify(Object.fromEntries(flightState), null, 2));
  }

  const voosMatch = url.match(/^\/voos\/([A-Z0-9]+)$/);
  if (voosMatch) {
    const cs = voosMatch[1];
    const flight = flightState.get(cs);
    if (!flight) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Voo nao encontrado' })); }
    res.writeHead(200);
    return res.end(JSON.stringify(flight, null, 2));
  }

  const histMatch = url.match(/^\/historico\/([A-Z0-9]+)$/);
  if (histMatch) {
    const cs = histMatch[1];
    dbClient.execute(
      `SELECT lat, lng, altitude, speed, heading, phase, ts FROM telemetria_by_callsign WHERE callsign = ? LIMIT 100`,
      [cs],
      { prepare: true }
    ).then(result => {
      res.writeHead(200);
      res.end(JSON.stringify({ callsign: cs, points: result.rows }));
    }).catch(err => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (url === '/eventos') {
    dbClient.execute(`SELECT callsign, evento, payload, created_at FROM eventos_latest WHERE bucket = 'eventos' LIMIT 50`)
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
  res.end(JSON.stringify({ error: 'Rota nao encontrada' }));
}

// ─── Inicialização ────────────────────────────────────────────────────────────
async function main() {
  await initDb();
  
  let dbOk = false;
  for (let i = 0; i < 10; i++) {
    try {
      await dbClient.connect();
      dbOk = true;
      break;
    } catch {
      console.log(`[SERVIDOR] Aguardando conexao com o Cassandra... tentativa ${i+1}/10`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  if (!dbOk) {
    console.error('[SERVIDOR] Banco indisponivel. Continuando sem persistencia.');
  }

  httpServer.listen(CFG.httpPort, '0.0.0.0', () => {
    console.log(`[SERVIDOR] HTTP/WebSocket na porta ${CFG.httpPort}`);
  });

  iniciarConexaoMqtt();
}

main().catch(err => { console.error('[SERVIDOR] Erro fatal:', err); process.exit(1); });

process.on('SIGTERM', () => {
  console.log('[SERVIDOR] Encerrando conexoes.');
  if (mqttClient) mqttClient.end();
  dbClient.shutdown();
  httpServer.close(() => process.exit(0));
});