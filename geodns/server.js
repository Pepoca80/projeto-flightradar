const express = require('express');
const net = require('net');
const fs = require('fs');
const app = express();

// Função para ler e atualizar a lista de brokers ativos
function getBrokersAtivos() {
  const config = JSON.parse(fs.readFileSync('./brokers-ativos.json', 'utf8'));
  // Filtra apenas as chaves onde o valor é true
  return Object.keys(config.brokers).filter(key => config.brokers[key]);
}

const regioes = [
  { id: 'sul', host: 'broker_sul', latMin: -33.7519, latMax: -22.5113, lonMin: -57.6492, lonMax: -48.0264 },
  { id: 'sudeste', host: 'broker_sudeste', latMin: -25.4300, latMax: -14.2271, lonMin: -51.5273, lonMax: -39.6997 },
  { id: 'centro_oeste', host: 'broker_centro_oeste', latMin: -24.3333, latMax: -7.3481, lonMin: -61.6420, lonMax: -45.9126 },
  { id: 'nordeste', host: 'broker_nordeste', latMin: -18.3516, latMax: -1.0494, lonMin: -48.7690, lonMax: -34.7891 },
  { id: 'norte', host: 'broker_norte', latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }
];

function verificarSaudeBroker(host) {
  return new Promise((resolve) => {
    // Verifica se o host solicitado está na lista de ativos atual
    if (!getBrokersAtivos().includes(host)) return resolve(false);

    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.connect(1883, host);

    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

app.get('/resolver', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  // Recarrega a lista de ativos a cada requisição (permite mudanças sem restartar o GeoDNS)
  const ativos = getBrokersAtivos();

  // Encontra a região teórica
  let regiaoPrincipal = regioes.find(r => lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) || regioes[4];

  // 1. Tenta usar o broker da região principal, SE ele estiver na lista de ativos
  if (ativos.includes(regiaoPrincipal.host)) {
    if (await verificarSaudeBroker(regiaoPrincipal.host)) {
      return res.json({ brokerUrl: `mqtt://${regiaoPrincipal.host}:1883` });
    }
  }

  // 2. Se falhou ou não estava ativo, tenta qualquer um que esteja na lista de ativos
  console.log(`Rota principal (${regiaoPrincipal.host}) indisponível ou desativada. Buscando contingência...`);

  for (const hostAtivo of ativos) {
    if (hostAtivo === regiaoPrincipal.host) continue;

    if (await verificarSaudeBroker(hostAtivo)) {
      console.log(`Redirecionando tráfego para contingência: ${hostAtivo}`);
      return res.json({ brokerUrl: `mqtt://${hostAtivo}:1883` });
    }
  }

  return res.status(503).json({ error: "Nenhum broker da lista de ativos está disponível" });
});

app.listen(8080, () => {
  console.log("GeoDNS Dinâmico rodando. Edite 'brokers-ativos.json' para alterar a disponibilidade.");
});