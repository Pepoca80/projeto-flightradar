'use strict';
/**
 * USP Airlines — servidor de aplicação
 *
 * Este processo recebe telemetria dos aviões via MQTT, mantém o estado dos
 * voos em memória, distribui atualizações por WebSocket, expõe uma API REST e
 * persiste histórico no Cassandra.
 */

const mqtt      = require('mqtt');
const WebSocket = require('ws');
const http      = require('http');
const cassandra = require('cassandra-driver');

// ─── Configuração ─────────────────────────────────────────────────────────────
// CFG guarda toda a configuração do servidor lida por variáveis de ambiente.
// Cada campo abaixo controla um aspecto da conexão com rede, GeoDNS e banco.
const CFG = {
  httpPort:   parseInt(process.env.HTTP_PORT || '4000'), // Porta HTTP e WebSocket do servidor
  clientId:   `servidor_app_${Date.now()}`,              // Identificador único da conexão MQTT
  dbContact:  process.env.CASSANDRA_CONTACT_POINTS || 'banco', // Host do Cassandra
  dbDc:       process.env.CASSANDRA_DATACENTER || 'datacenter1', // Data center local do cluster
  dbKeyspace: process.env.CASSANDRA_KEYSPACE || 'usp_airlines',   // Keyspace usado nas consultas
  dbReplicationFactor: parseInt(process.env.CASSANDRA_REPLICATION_FACTOR || '1'), // Replica do keyspace
  geoDnsUrl:  process.env.GEODNS_URL || 'http://geodns:8080',     // URL do serviço GeoDNS
  lat:        process.env.SERVER_LAT || '-23.5505',               // Latitude usada para descobrir a região
  lon:        process.env.SERVER_LON || '-46.6333'                // Longitude usada para descobrir a região
};

// ─── Estado em Memória ─────────────────────────────────────────────────────────
// flightState mantém o último estado conhecido de cada voo em memória.
const flightState = new Map();
let   totalMsgs   = 0; // Total de mensagens MQTT processadas desde a inicialização
let   msgsPerSec  = 0; // Taxa atual de mensagens por segundo
let   msgsWindow  = 0; // Janela de contagem usada para calcular msgsPerSec

// Atualiza a métrica de mensagens por segundo a cada 1 segundo.
setInterval(() => { msgsPerSec = msgsWindow; msgsWindow = 0; }, 1000);

// ─── Apache Cassandra ─────────────────────────────────────────────────────────
// dbClient é o cliente principal usado para persistir e consultar dados no Cassandra.
const dbClient = new cassandra.Client({
  contactPoints: [CFG.dbContact],
  localDataCenter: CFG.dbDc,
  keyspace: CFG.dbKeyspace
});

// Cria keyspace e tabelas necessárias caso ainda não existam.
async function initDb() {
  // setupClient é um cliente temporário usado apenas para criar o schema inicial.
  const setupClient = new cassandra.Client({
    contactPoints: [CFG.dbContact],
    localDataCenter: CFG.dbDc
  });

  try {
    await setupClient.connect();
    
    await setupClient.execute(`
      CREATE KEYSPACE IF NOT EXISTS ${CFG.dbKeyspace}
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': ${CFG.dbReplicationFactor}};
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

// Persiste uma amostra de telemetria do voo na tabela por callsign, que é o identificador único do voo.
async function persistTelemetria(data) {
  // query define a escrita das medições de posição e estado do voo.
  const query = `
    INSERT INTO telemetria_by_callsign 
    (callsign, ts, id, airline, origin, destination, lat, lng, altitude, speed, heading, phase, progress, created_at)
    VALUES (?, ?, now(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, toTimestamp(now()))
  `;
  // params reúne os valores que vêm do payload MQTT do avião.
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

// Persiste eventos do ciclo de vida do voo, como decolagem, pouso e desconexão.
async function persistEvento(callsign, evento, payload) {
  // A tabela eventos_latest guarda os últimos eventos de todos os voos.
  const query = `
    INSERT INTO eventos_latest (bucket, created_at, id, callsign, evento, payload)
    VALUES ('eventos', toTimestamp(now()), now(), ?, ?, ?)
  `;
  // JSON.stringify preserva o payload completo do evento dentro do banco.
  const params = [callsign, evento, JSON.stringify(payload)];

  try {
    await dbClient.execute(query, params, { prepare: true });
  } catch (err) {
    console.error('[SERVIDOR] Erro ao persistir evento:', err.message);
  }
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
// httpServer atende REST e também serve de base para o WebSocket.
const httpServer = http.createServer(handleHttp);
// wss distribui updates em tempo real para o frontend.
const wss = new WebSocket.Server({ server: httpServer });

// wsClients mantém todos os clientes web conectados no momento.
const wsClients = new Set();

// Ao conectar, envia um snapshot inicial para o cliente e passa a acompanhar a sessão.
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

// Envia uma mensagem para todos os clientes WebSocket conectados.
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  });
}

// ─── MQTT Subscriber Inteligente via GeoDNS ───────────────────────────────────
// mqttClient é a conexão MQTT ativa com o broker regional resolvido via GeoDNS.
let mqttClient = null;

// Consulta o GeoDNS para descobrir qual broker MQTT regional este servidor deve usar.
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

// Conecta ao broker retornado pelo GeoDNS e assina os tópicos do projeto.
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

  // clean=true faz a sessão começar limpa, pois o estado relevante fica em memória e no banco.
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

// PERSIST_EVERY define de quantas em quantas mensagens de telemetria uma amostra será salva no banco.
const PERSIST_EVERY = 10;
// persistCounters acompanha quantas telemetrias já foram processadas por voo.
const persistCounters = new Map();

// Atualiza o estado em memória do voo e grava uma amostra no Cassandra periodicamente.
function handleTelemetria(data) {
  // cs é o callsign do voo, usado como chave principal do estado.
  const cs = data.callsign;
  flightState.set(cs, data);

  // Repassa a telemetria para todos os clientes web em tempo real.
  broadcast({ type: 'TELEMETRIA', payload: data, ts: Date.now() });

  // Incrementa o contador de amostras desse voo para decidir quando persistir.
  const cnt = (persistCounters.get(cs) || 0) + 1;
  persistCounters.set(cs, cnt);
  if (cnt % PERSIST_EVERY === 0) {
    persistTelemetria(data);
  }
}

// Processa eventos de decolagem, pouso, desconexão e emergência.
function handleEvento(data) {
  // cs é o callsign do voo que gerou o evento.
  const cs = data.callsign || 'unknown';
  console.log(`[SERVIDOR] Evento: ${data.evento} | ${cs}`);

  // Quando o voo termina ou desconecta, remove-o do estado ativo em memória.
  if (data.evento === 'pousou' || data.evento === 'desconectou') {
    flightState.delete(cs);
    persistCounters.delete(cs);
  }

  // Envia o evento para os clientes WebSocket e também persiste no Cassandra.
  broadcast({ type: 'EVENTO', payload: data, ts: Date.now() });
  persistEvento(cs, data.evento, data);
}

// ─── REST API ─────────────────────────────────────────────────────────────────
// Calcula métricas operacionais do servidor para o endpoint /status.
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

// handleHttp expõe os endpoints REST do projeto.
function handleHttp(req, res) {
  // Permite chamadas do frontend em outro container/porta.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Remove query string para facilitar a comparação com as rotas.
  const url = req.url.split('?')[0];

  if (url === '/status') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', ...getMetrics() }, null, 2));
  }

  // Retorna todos os voos atualmente guardados em memória.
  if (url === '/voos') {
    res.writeHead(200);
    return res.end(JSON.stringify(Object.fromEntries(flightState), null, 2));
  }

  // Retorna o estado atual de um voo específico pelo callsign.
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

  // Retorna os últimos 50 eventos de ciclo de vida gravados no Cassandra.
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
// main inicializa banco, abre portas HTTP/WebSocket e começa a consumir MQTT.
async function main() {
  await initDb();
  
  // Tenta conectar ao Cassandra várias vezes antes de seguir sem persistência.
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

  // Sobe a API REST e o servidor WebSocket no mesmo processo.
  httpServer.listen(CFG.httpPort, '0.0.0.0', () => {
    console.log(`[SERVIDOR] HTTP/WebSocket na porta ${CFG.httpPort}`);
  });

  // Inicia a conexão MQTT com o broker regional resolvido pelo GeoDNS.
  iniciarConexaoMqtt();
}

main().catch(err => { console.error('[SERVIDOR] Erro fatal:', err); process.exit(1); });

// Encerra conexões e o servidor de forma limpa ao receber SIGTERM.
process.on('SIGTERM', () => {
  console.log('[SERVIDOR] Encerrando conexoes.');
  if (mqttClient) mqttClient.end();
  dbClient.shutdown();
  httpServer.close(() => process.exit(0));
});