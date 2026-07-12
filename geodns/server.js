const express = require('express');
const app = express();

app.get('/resolver', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (lat >= -33.7519 && lat <= -22.5113 && lon >= -57.6492 && lon <= -48.0264) {
    return res.json({ brokerUrl: "mqtt://broker_sul:1883" });
  }
  
  if (lat >= -25.4300 && lat <= -14.2271 && lon >= -51.5273 && lon <= -39.6997) {
    return res.json({ brokerUrl: "mqtt://broker_sudeste:1883" });
  }
  
  if (lat >= -24.3333 && lat <= -7.3481 && lon >= -61.6420 && lon <= -45.9126) {
    return res.json({ brokerUrl: "mqtt://broker_centro_oeste:1883" });
  }
  
  if (lat >= -18.3516 && lat <= -1.0494 && lon >= -48.7690 && lon <= -34.7891) {
    return res.json({ brokerUrl: "mqtt://broker_nordeste:1883" });
  }

  return res.json({ brokerUrl: "mqtt://broker_norte:1883" });
});

app.listen(8080, () => {
  console.log("Servico GeoDNS rodando e aguardando aeronaves");
});