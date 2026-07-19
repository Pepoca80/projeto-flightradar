const express = require('express');
const net = require('net');
const fs = require('fs');
const app = express();


// Lê o arquivo brokers-ativos.json e retorna apenas os brokers habilitados.
function getBrokersAtivos() {
  const config = JSON.parse(fs.readFileSync('./brokers-ativos.json', 'utf8'));
  
  return Object.keys(config.brokers).filter(key => config.brokers[key]);
}

// Mapa das regiões atendidas pelo sistema.
// Cada entrada define a área geográfica e o broker MQTT correspondente.
const regioes = [
  { id: 'sul', host: 'broker_sul', latMin: -33.7519, latMax: -22.5113, lonMin: -57.6492, lonMax: -48.0264 },
  { id: 'sudeste', host: 'broker_sudeste', latMin: -25.4300, latMax: -14.2271, lonMin: -51.5273, lonMax: -39.6997 },
  { id: 'centro_oeste', host: 'broker_centro_oeste', latMin: -24.3333, latMax: -7.3481, lonMin: -61.6420, lonMax: -45.9126 },
  { id: 'nordeste', host: 'broker_nordeste', latMin: -18.3516, latMax: -1.0494, lonMin: -48.7690, lonMax: -34.7891 },
  { id: 'norte', host: 'broker_norte', latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }
];

// Testa se um broker está ativo no arquivo de configuração e se responde na porta 1883.
function verificarSaudeBroker(host) {
  return new Promise((resolve) => {
    
    if (!getBrokersAtivos().includes(host)) return resolve(false);

    const socket = new net.Socket();
    socket.setTimeout(1500); 
    socket.connect(1883, host);

    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// Endpoint principal do GeoDNS.
// Recebe lat/lon, escolhe a região correspondente e devolve o broker MQTT mais adequado.
app.get('/resolver', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  // Lista de brokers liberados para uso no momento.
  const ativos = getBrokersAtivos();

  // Identifica a região principal com base na posição informada.
  let regiaoPrincipal = regioes.find(r => lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) || regioes[4];

  // Se a região principal estiver ativa e saudável, retorna o broker dela.
  if (ativos.includes(regiaoPrincipal.host)) {
    if (await verificarSaudeBroker(regiaoPrincipal.host)) {
      return res.json({ brokerUrl: `mqtt://${regiaoPrincipal.host}:1883` });
    }
  }

  // Se a região principal falhar, tenta redirecionar para um broker de contingência.
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

// Sobe o serviço GeoDNS na porta 8080.
app.listen(8080, () => {
  console.log("GeoDNS Dinâmico rodando. Edite 'brokers-ativos.json' para alterar a disponibilidade.");
});