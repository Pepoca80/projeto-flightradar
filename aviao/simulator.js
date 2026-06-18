'use strict';
/**
 * AeroTrack BR — Simulador de Avião (MQTT Publisher)
 *
 * Cada instância deste processo representa um avião independente.
 * Configuração via variáveis de ambiente.
 *
 * Conceitos de SD aplicados:
 *  - Publisher desacoplado: não conhece subscribers
 *  - QoS 0 para telemetria (fire-and-forget — dados antigos sem valor)
 *  - QoS 1 para eventos de ciclo de vida (garantia de entrega)
 *  - Reconexão com backoff exponencial (tolerância a falhas do broker)
 *  - Estado local mínimo (stateless em relação ao sistema)
 */

const mqtt = require('mqtt');

// ─── Configuração via ambiente ────────────────────────────────────────────────
const CFG = {
  brokerUrl:   process.env.BROKER_URL   || 'mqtt://broker:1883',
  callsign:    process.env.CALLSIGN     || 'XX0000',
  airline:     process.env.AIRLINE      || 'TEST',
  iataAirline: process.env.IATA_AIRLINE || 'XT',
  origin:      process.env.ORIGIN       || 'GRU',
  destination: process.env.DESTINATION  || 'GIG',
  updateMs:    parseInt(process.env.UPDATE_MS || '1000'),
  clientId:    `aviao_${process.env.CALLSIGN || 'XX0000'}_${Date.now()}`,
};

// ─── Aeroportos brasileiros (coordenadas reais) ───────────────────────────────
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
const orig = AIRPORTS[CFG.origin]      || AIRPORTS.GRU;
const dest = AIRPORTS[CFG.destination] || AIRPORTS.GIG;

// Heading inicial (graus)
const dLng = dest.lng - orig.lng;
const dLat = dest.lat - orig.lat;
const heading = ((Math.atan2(dLng, dLat) * 180 / Math.PI) + 360) % 360;

// Distância aproximada em km
const distKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111;

// Parâmetros de voo simulados
const CRUISE_ALT   = Math.round(28000 + Math.random() * 13000); // ft
const CRUISE_SPEED = Math.round(750   + Math.random() * 130);   // km/h
const SQUAWK       = Math.floor(1000  + Math.random() * 6777).toString();

// Fração de progresso avançada por tick
const PROGRESS_STEP = (CFG.updateMs / 1000) / (distKm / CRUISE_SPEED * 3600);

const state = {
  lat:          orig.lat,
  lng:          orig.lng,
  altitude:     0,
  speed:        0,
  heading:      Math.round(heading),
  verticalSpeed: 0,
  progress:     0.01,
  phase:        'climbing',   // ground | climbing | cruise | descending | landed
  squawk:       SQUAWK,
};

function lerp(a, b, t) { return a + (b - a) * t; }
function rand(min, max) { return min + Math.random() * (max - min); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function updatePhysics() {
  state.progress = Math.min(1, state.progress + PROGRESS_STEP * rand(0.85, 1.15));

  // Determinar fase de voo
  if      (state.progress < 0.01)  state.phase = 'ground';
  else if (state.progress < 0.12)  state.phase = 'climbing';
  else if (state.progress < 0.82)  state.phase = 'cruise';
  else if (state.progress < 0.99)  state.phase = 'descending';
  else                             state.phase = 'landed';

  const dt = CFG.updateMs / 60000; // fração de minuto

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
const TOPICS = {
  telemetria: `voo/${CFG.iataAirline}/${CFG.callsign}/telemetria`,
  evento:     `voo/eventos`,
  controle:   `controle/${CFG.callsign}`,
  status:     `$SYS/aviao/${CFG.callsign}/status`,
};

// ─── Conexão MQTT com reconexão automática ────────────────────────────────────
let tickInterval = null;

const client = mqtt.connect(CFG.brokerUrl, {
  clientId:      CFG.clientId,
  clean:         true,
  reconnectPeriod: 2000,      // tenta reconectar a cada 2s
  connectTimeout: 10000,
  will: {
    // Last Will Testament: broker publica automaticamente se o avião desconectar
    topic:   TOPICS.evento,
    payload: JSON.stringify({
      evento:    'desconectou',
      callsign:  CFG.callsign,
      airline:   CFG.airline,
      origin:    CFG.origin,
      destination: CFG.destination,
      ts:        Date.now(),
    }),
    qos: 1,
    retain: false,
  },
});

function publish(topic, payload, qos = 0, retain = false) {
  if (!client.connected) return;
  client.publish(topic, JSON.stringify(payload), { qos, retain }, (err) => {
    if (err) console.error(`[${CFG.callsign}] Erro ao publicar em ${topic}:`, err.message);
  });
}

client.on('connect', () => {
  console.log(`[${CFG.callsign}] ✓ Conectado ao broker | Rota: ${CFG.origin}→${CFG.destination} | ${Math.round(distKm)}km`);

  // Subscrever canal de controle (comandos remotos)
  client.subscribe(TOPICS.controle, { qos: 1 });

  // Publicar evento de decolagem (QoS 1 — garantir entrega)
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

  // Publicar posição inicial como retained (novos subscribers recebem imediatamente)
  publishTelemetria(true);

  // Loop de telemetria
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, CFG.updateMs);
});

client.on('message', (topic, message) => {
  if (topic === TOPICS.controle) {
    try {
      const cmd = JSON.parse(message.toString());
      console.log(`[${CFG.callsign}] Comando recebido:`, cmd);
      // Aqui poderiam ser tratados: altitude_change, speed_change, emergency, etc.
    } catch {}
  }
});

client.on('reconnect', () => {
  console.log(`[${CFG.callsign}] Reconectando ao broker...`);
});

client.on('error', (err) => {
  console.error(`[${CFG.callsign}] Erro MQTT: ${err.message}`);
});

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
  // QoS 0: telemetria é fire-and-forget (dado antigo = sem valor)
  publish(TOPICS.telemetria, payload, 0, retain);
}

function tick() {
  updatePhysics();
  publishTelemetria(false);

  // Log a cada 10% de progresso
  const pct = Math.round(state.progress * 100);
  if (pct % 10 === 0 && pct > 0) {
    console.log(`[${CFG.callsign}] ${pct}% | fase=${state.phase} | alt=${Math.round(state.altitude)}ft | spd=${Math.round(state.speed)}km/h`);
  }

  if (state.phase === 'landed') {
    // Publicar evento de pouso (QoS 1)
    publish(TOPICS.evento, {
      evento:      'pousou',
      callsign:    CFG.callsign,
      airline:     CFG.airline,
      origin:      CFG.origin,
      destination: CFG.destination,
      ts:          Date.now(),
    }, 1);

    console.log(`[${CFG.callsign}] ✓ Pousou em ${CFG.destination}. Encerrando em 3s.`);
    clearInterval(tickInterval);
    setTimeout(() => { client.end(); process.exit(0); }, 3000);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log(`[${CFG.callsign}] SIGTERM — publicando emergência e encerrando.`);
  publish(TOPICS.evento, {
    evento:    'emergencia',
    callsign:  CFG.callsign,
    reason:    'SIGTERM',
    ts:        Date.now(),
  }, 1);
  clearInterval(tickInterval);
  setTimeout(() => { client.end(); process.exit(0); }, 1000);
});

process.on('SIGINT', () => process.emit('SIGTERM'));
