const express = require('express');
const net = require('net');
const app = express();

// Lista estruturada de todas as regioes e seus respectivos limites geograficos
const regioes = [
  { id: 'sul', host: 'broker_sul', latMin: -33.7519, latMax: -22.5113, lonMin: -57.6492, lonMax: -48.0264 },
  { id: 'sudeste', host: 'broker_sudeste', latMin: -25.4300, latMax: -14.2271, lonMin: -51.5273, lonMax: -39.6997 },
  { id: 'centro_oeste', host: 'broker_centro_oeste', latMin: -24.3333, latMax: -7.3481, lonMin: -61.6420, lonMax: -45.9126 },
  { id: 'nordeste', host: 'broker_nordeste', latMin: -18.3516, latMax: -1.0494, lonMin: -48.7690, lonMax: -34.7891 },
  { id: 'norte', host: 'broker_norte', latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 }
];

// Funcao auxiliar que tenta abrir uma conexao rapida TCP para testar se o broker esta vivo
function verificarSaudeBroker(host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000); 
    
    socket.on('connect', () => { 
      socket.destroy(); 
      resolve(true); 
    });
    
    socket.on('timeout', () => { 
      socket.destroy(); 
      resolve(false); 
    });
    
    socket.on('error', () => { 
      resolve(false); 
    });
    
    socket.connect(1883, host);
  });
}

app.get('/resolver', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  // Encontra a regiao teorica principal com base nas coordenadas
  let regiaoPrincipal = regioes.find(r => lat >= r.latMin && lat <= r.latMax && lon >= r.lonMin && lon <= r.lonMax) || regioes[4];

  // Testa se o broker principal esta online
  const principalOnline = await verificarSaudeBroker(regiaoPrincipal.host);
  if (principalOnline) {
    return res.json({ brokerUrl: `mqtt://${regiaoPrincipal.host}:1883` });
  }

  console.log(`Broker ${regiaoPrincipal.host} indisponivel. Buscando rota de contingencia...`);

  // Se o principal caiu iteramos pelas outras regioes para achar a primeira disponivel
  for (const regiao of regioes) {
    if (regiao.id === regiaoPrincipal.id) continue;
    
    const contingenciaOnline = await verificarSaudeBroker(regiao.host);
    if (contingenciaOnline) {
      console.log(`Redirecionando trafego para ${regiao.host}`);
      return res.json({ brokerUrl: `mqtt://${regiao.host}:1883` });
    }
  }

  // Caso catastrofico onde todos os 5 brokers cairam simultaneamente
  return res.status(503).json({ error: "Nenhum broker disponivel na malha aerea" });
});

app.listen(8080, () => {
  console.log("Servico GeoDNS rodando e aguardando solicitacoes de roteamento");
});