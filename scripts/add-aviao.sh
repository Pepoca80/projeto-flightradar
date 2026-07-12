#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  usp-airline — Adicionar avião dinamicamente
#  Uso: ./scripts/add-aviao.sh CALLSIGN AIRLINE IATA ORIGIN DESTINATION [MS]
#  Ex:  ./scripts/add-aviao.sh LA9999 LATAM LA GRU POA 1000
# ─────────────────────────────────────────────────────────────────────────────
set -e
CALLSIGN=${1:?CALLSIGN obrigatório}
AIRLINE=${2:?AIRLINE obrigatório}
IATA=${3:?IATA obrigatório}
ORIGIN=${4:?ORIGIN obrigatório}
DEST=${5:?DESTINATION obrigatório}
MS=${6:-1000}
NAME="usp-airline-aviao-${CALLSIGN}"

echo "▶ Iniciando $CALLSIGN | $AIRLINE | $ORIGIN→$DEST"
docker build -t usp-airline-aviao ./aviao -q
docker rm -f "$NAME" 2>/dev/null || true
docker run -d --name "$NAME" \
  --network usp-airline-net \
  -e BROKER_URL=mqtt://broker:1883 \
  -e CALLSIGN="$CALLSIGN" \
  -e AIRLINE="$AIRLINE" \
  -e IATA_AIRLINE="$IATA" \
  -e ORIGIN="$ORIGIN" \
  -e DESTINATION="$DEST" \
  -e UPDATE_MS="$MS" \
  usp-airline-aviao
echo "✓ $CALLSIGN voando! Veja em http://localhost:3000"
echo "  Logs: docker logs -f $NAME"
