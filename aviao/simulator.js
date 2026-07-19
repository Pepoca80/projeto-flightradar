'use strict';

/**
 * USP Airlines — simulator.js
 * Simulador de avião que publica telemetria via MQTT.
 *
 * Responsabilidade:
 *  simular um voo entre dois aeroportos brasileiros, atualizar a posição,
 *  altitude, velocidade e fase do voo, e publicar esses dados no broker.
 *
 * Fluxo principal:
 *  1. Lê a configuração do voo por variáveis de ambiente.
 *  2. Consulta o GeoDNS para escolher o broker MQTT regional.
 *  3. Conecta ao broker, publica a decolagem e inicia os ticks.
 *  4. A cada tick, atualiza a física do voo e envia telemetria.
 *  5. Quando pousa, publica o evento final e encerra o processo.
 *  6. Se o broker cair, consulta o GeoDNS de novo e reconecta.
 */

const mqtt = require('mqtt');

// ─── Configuração via ambiente ────────────────────────────────────────────────
const CFG = {
  geoDnsUrl:   process.env.GEODNS_URL   || 'http://geodns:8080',
  callsign:    process.env.CALLSIGN     || 'XX0000',
  airline:     process.env.AIRLINE      || 'TEST',
  iataAirline: process.env.IATA_AIRLINE || 'XT',
  origin:      process.env.ORIGIN       || 'GRU',
  destination: process.env.DESTINATION  || 'GIG',
  updateMs:    parseInt(process.env.UPDATE_MS || '1000'),
  clientId:    `aviao_${process.env.CALLSIGN || 'XX0000'}_${Date.now()}`,
};

// ─── Aeroportos Brasileiros (Coordenadas Reais) ───────────────────────────────
const AIRPORTS = {
  GRU: { lat: -23.4356, lng: -46.4731, city: 'São Paulo',       name: 'Guarulhos'      },
  CGH: { lat: -23.6261, lng: -46.6564, city: 'São Paulo',       name: 'Congonhas'      },
  VCP: { lat: -23.0074, lng: -47.1345, city: 'Campinas',        name: 'Viracopos'      },
  GIG: { lat: -22.8099, lng: -43.2505, city: 'Rio de Janeiro',  name: 'Galeão'         },
  SDU: { lat: -22.9105, lng: -43.1631, city: 'Rio de Janeiro',  name: 'Santos Dumont'  },
  BSB: { lat: -15.8711, lng: -47.9186, city: 'Brasília',        name: 'Juscelino K.'   },
  SSA: { lat: -12.9086, lng: -38.3225, city: 'Salvador',        name: 'Dep. Luís E.'   },
  FOR: { lat:  -3.7763, lng: -38.5326, city: 'Fortaleza',       name: 'Pinto Martins'  },
  REC: { lat:  -8.1265, lng: -34.9235, city: 'Recife',          name: 'Guararapes'     },
  CWB: { lat: -25.5285, lng: -49.1758, city: 'Curitiba',        name: 'Afonso Pena'    },
  POA: { lat: -29.9939, lng: -51.1714, city: 'Porto Alegre',    name: 'Salgado Filho'  },
  MAO: { lat:  -3.0386, lng: -60.0497, city: 'Manaus',          name: 'Eduardo Gomes'  },
  BEL: { lat:  -1.3792, lng: -48.4762, city: 'Belém',           name: 'Val-de-Cans'    },
  THE: { lat:  -5.0600, lng: -42.8236, city: 'Teresina',        name: 'Senador Petrônio'},
  NAT: { lat:  -5.9114, lng: -35.2476, city: 'Natal',           name: 'São Gonçalo'    },
  MCZ: { lat:  -9.5108, lng: -35.7917, city: 'Maceió',          name: 'Zumbi dos Palmares'},
  FLN: { lat: -27.6702, lng: -48.5522, city: 'Florianópolis',   name: 'Hercílio Luz'   },
  GYN: { lat: -16.6320, lng: -49.2207, city: 'Goiânia',         name: 'Santa Genoveva' },
};

// ─── Estado do voo ────────────────────────────────────────────────────────────
// Origem e destino do voo; se a sigla não existir, usa um aeroporto padrão.
const orig = AIRPORTS[CFG.origin]      || AIRPORTS.GRU;
const dest = AIRPORTS[CFG.destination] || AIRPORTS.GIG;

// dLng = diferença de longitude entre destino e origem.
// dLat = diferença de latitude entre destino e origem.
const dLng = dest.lng - orig.lng;
const dLat = dest.lat - orig.lat;

// Heading = rumo inicial do voo, calculado a partir da diferença entre os pontos.
const heading = ((Math.atan2(dLng, dLat) * 180 / Math.PI) + 360) % 360;

// distKm = distância aproximada em quilômetros entre origem e destino.
const distKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111;

// CRUISE_ALT = altitude de cruzeiro simulada do voo, em pés.
// CRUISE_SPEED = velocidade de cruzeiro simulada, em km/h.
// SQUAWK = código transponder simulando o identificador de radar.
const CRUISE_ALT   = Math.round(28000 + Math.random() * 13000);
const CRUISE_SPEED = Math.round(750   + Math.random() * 130);
const SQUAWK       = Math.floor(1000  + Math.random() * 6777).toString();

// PROGRESS_STEP = avanço estimado do voo a cada tick com base no tempo e na distância.
const PROGRESS_STEP = (CFG.updateMs / 1000) / (distKm / CRUISE_SPEED * 3600);

const state = {
  lat:          orig.lat,
  lng:          orig.lng,
  altitude:     0,
  speed:        0,
  heading:      Math.round(heading),
  verticalSpeed: 0,
  progress:     0.01,
  phase:        'climbing',
  squawk:       SQUAWK,
};

// Interpola entre dois valores; usada para posicionar o avião ao longo da rota.
function lerp(a, b, t) { return a + (b - a) * t; }

// Gera um valor aleatório dentro de um intervalo.
function rand(min, max) { return min + Math.random() * (max - min); }

// Limita um valor entre mínimo e máximo.
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Atualiza a física do voo, alterando fase, posição, altitude, velocidade e rumo.
function updatePhysics() {
  state.progress = Math.min(1, state.progress + PROGRESS_STEP * rand(0.85, 1.15));

  if      (state.progress < 0.01)  state.phase = 'ground';
  else if (state.progress < 0.12)  state.phase = 'climbing';
  else if (state.progress < 0.82)  state.phase = 'cruise';
  else if (state.progress < 0.99)  state.phase = 'descending';
  else                             state.phase = 'landed';

  const dt = CFG.updateMs / 60000;

  switch (state.phase) {
    case 'ground':
      state.altitude      = 0;
      state.speed         = 0;
      state.verticalSpeed = 0;
      break;
    case 'climbing':
      state.altitude      = clamp(state.altitude + 2200 * dt, 0, CRUISE_ALT);
      state.speed         = clamp(state.speed + 50 * dt, 0, CRUISE_SPEED);
      state.verticalSpeed = 2200;
      break;
    case 'cruise':
      state.altitude      = clamp(CRUISE_ALT + rand(-150, 150), 0, 45000);
      state.speed         = clamp(CRUISE_SPEED + rand(-15, 15), 400, 950);
      state.verticalSpeed = Math.round(rand(-80, 80));
      state.heading       = (state.heading + rand(-0.5, 0.5) + 360) % 360;
      break;
    case 'descending':
      state.altitude      = clamp(state.altitude - 1800 * dt, 0, CRUISE_ALT);
      state.speed         = clamp(state.speed - 30 * dt, 250, CRUISE_SPEED);
      state.verticalSpeed = -1800;
      break;
    case 'landed':
      state.altitude      = 0;
      state.speed         = 0;
      state.verticalSpeed = 0;
      break;
  }

  state.lat = lerp(orig.lat, dest.lat, state.progress);
  state.lng = lerp(orig.lng, dest.lng, state.progress);
}

// ─── Tópicos MQTT ─────────────────────────────────────────────────────────────
// Define os tópicos que este avião publica e assina no broker MQTT.
const TOPICS = {
  telemetria: `voo/${CFG.iataAirline}/${CFG.callsign}/telemetria`,
  evento:     `voo/eventos`,
  controle:   `controle/${CFG.callsign}`,
  status:     `$SYS/aviao/${CFG.callsign}/status`,
};

// ─── Conexão MQTT dinâmica via GeoDNS ─────────────────────────────────────────
// tickInterval guarda o timer do loop de simulação.
let tickInterval = null;
// client guarda a conexão MQTT ativa do avião.
let client = null;

// Consulta o GeoDNS para descobrir qual broker MQTT deve atender este avião.
async function obterRotaGeoDns() {
  try {
    const resposta = await fetch(`${CFG.geoDnsUrl}/resolver?lat=${state.lat}&lon=${state.lng}`);
    const dados = await resposta.json();
    return dados.brokerUrl;
  } catch (erro) {
    console.error(`[${CFG.callsign}] Erro ao consultar a API do GeoDNS:`, erro);
    return null;
  }
}

// Inicia ou reinicia a conexão MQTT usando a rota retornada pelo GeoDNS.
async function iniciarConexaoMqtt() {
  if (client) {
    client.end();
  }

  const brokerUrl = await obterRotaGeoDns();

  if (!brokerUrl) {
    console.log(`[${CFG.callsign}] Falha ao obter rota. Tentando novamente em 5 segundos`);
    setTimeout(iniciarConexaoMqtt, 5000);
    return;
  }

  console.log(`[${CFG.callsign}] Rota encontrada. Iniciando conexao MQTT via GeoDNS: ${brokerUrl}`);

  client = mqtt.connect(brokerUrl, {
    clientId:      CFG.clientId,
    clean:         true,
    reconnectPeriod: 0,
    connectTimeout: 10000,
    will: {
      topic:   TOPICS.evento,
      payload: JSON.stringify({
        evento:      'desconectou',
        callsign:    CFG.callsign,
        airline:     CFG.airline,
        origin:      CFG.origin,
        destination: CFG.destination,
        ts:          Date.now(),
      }),
      qos: 1,
      retain: false,
    },
  });

  // Quando conecta, anuncia decolagem, publica telemetria inicial e inicia os ticks.
  client.on('connect', () => {
    console.log(`[${CFG.callsign}] ✓ Conectado ao broker | Rota: ${CFG.origin} para ${CFG.destination} | ${Math.round(distKm)}km`);

    client.subscribe(TOPICS.controle, { qos: 1 });

    publish(TOPICS.evento, {
      evento:       'decolou',
      callsign:     CFG.callsign,
      airline:      CFG.airline,
      iataAirline:  CFG.iataAirline,
      origin:       CFG.origin,
      destination:  CFG.destination,
      originCity:   orig.city,
      destCity:     dest.city,
      distKm:       Math.round(distKm),
      cruiseAlt:    CRUISE_ALT,
      squawk:       SQUAWK,
      ts:           Date.now(),
    }, 1);

    publishTelemetria(true);

    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(tick, CFG.updateMs);
  });

  // Recebe comandos remotos enviados ao tópico de controle do avião.
  client.on('message', (topic, message) => {
    if (topic === TOPICS.controle) {
      try {
        const cmd = JSON.parse(message.toString());
        console.log(`[${CFG.callsign}] Comando recebido:`, cmd);
      } catch {}
    }
  });

  // Se o broker cair, interrompe o loop e pede uma nova rota ao GeoDNS.
  client.on('offline', () => {
    console.warn(`[${CFG.callsign}] Broker offline. Solicitando rota alternativa ao GeoDNS em 3 segundos`);
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    setTimeout(iniciarConexaoMqtt, 3000);
  });

  client.on('error', (err) => {
    console.error(`[${CFG.callsign}] Erro MQTT: ${err.message}`);
  });
}

// Publica qualquer mensagem JSON em um tópico MQTT.
function publish(topic, payload, qos = 0, retain = false) {
  if (!client || !client.connected) return;
  client.publish(topic, JSON.stringify(payload), { qos, retain }, (err) => {
    if (err) console.error(`[${CFG.callsign}] Erro ao publicar em ${topic}:`, err.message);
  });
}

// Monta e publica o pacote de telemetria atual do avião.
function publishTelemetria(retain = false) {
  const payload = {
    callsign:      CFG.callsign,
    airline:       CFG.airline,
    iataAirline:   CFG.iataAirline,
    origin:        CFG.origin,
    destination:   CFG.destination,
    originCity:    orig.city,
    destCity:      dest.city,
    lat:           parseFloat(state.lat.toFixed(5)),
    lng:           parseFloat(state.lng.toFixed(5)),
    altitude:      Math.round(state.altitude),
    speed:         Math.round(state.speed),
    heading:       Math.round(state.heading),
    verticalSpeed: Math.round(state.verticalSpeed),
    phase:         state.phase,
    progress:      parseFloat(state.progress.toFixed(3)),
    squawk:        state.squawk,
    distKm:        Math.round(distKm),
    ts:            Date.now(),
  };
  publish(TOPICS.telemetria, payload, 0, retain);
}

// Executa um ciclo da simulação: atualiza o voo, publica telemetria e verifica pouso.
function tick() {
  updatePhysics();
  publishTelemetria(false);

  const pct = Math.round(state.progress * 100);
  if (pct % 10 === 0 && pct > 0) {
    console.log(`[${CFG.callsign}] ${pct}% | fase=${state.phase} | alt=${Math.round(state.altitude)}ft | spd=${Math.round(state.speed)}km/h`);
  }

  if (state.phase === 'landed') {
    publish(TOPICS.evento, {
      evento:      'pousou',
      callsign:    CFG.callsign,
      airline:     CFG.airline,
      origin:      CFG.origin,
      destination: CFG.destination,
      ts:          Date.now(),
    }, 1);

    console.log(`[${CFG.callsign}] ✓ Pousou em ${CFG.destination}. Encerrando em 3s.`);
    if (tickInterval) clearInterval(tickInterval);
    setTimeout(() => { if (client) client.end(); process.exit(0); }, 3000);
  }
}

// Encerra o avião de forma segura, publicando evento de emergência antes de sair.
process.on('SIGTERM', () => {
  console.log(`[${CFG.callsign}] SIGTERM — publicando emergência e encerrando.`);
  publish(TOPICS.evento, {
    evento:    'emergencia',
    callsign:  CFG.callsign,
    reason:    'SIGTERM',
    ts:        Date.now(),
  }, 1);
  if (tickInterval) clearInterval(tickInterval);
  setTimeout(() => { if (client) client.end(); process.exit(0); }, 1000);
});

process.on('SIGINT', () => process.emit('SIGTERM'));

// Inicia o processo buscando a primeira rota via GeoDNS
iniciarConexaoMqtt();