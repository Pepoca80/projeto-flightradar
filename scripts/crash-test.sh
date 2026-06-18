#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  AeroTrack BR — Teste de Tolerância a Falhas (Crash Failures)
#
#  Derruba containers de aviões aleatoriamente e verifica que o sistema
#  continua funcionando (broker, servidor e frontend não caem).
# ─────────────────────────────────────────────────────────────────────────────

echo "════════════════════════════════════════════════════════"
echo " AeroTrack BR — Teste de Crash Failures"
echo "════════════════════════════════════════════════════════"

check_server() {
  curl -sf http://localhost:4000/status > /dev/null 2>&1
  return $?
}

# 1. Verificar que o servidor está OK antes dos testes
echo ""
echo "[1] Verificando estado inicial do sistema..."
if check_server; then
  echo "    ✓ Servidor de aplicação respondendo"
else
  echo "    ✗ Servidor não está acessível. Abortando."
  exit 1
fi

VOOS_ANTES=$(curl -s http://localhost:4000/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('voosAtivos',0))" 2>/dev/null || echo "?")
echo "    Voos ativos antes: $VOOS_ANTES"

# 2. Listar containers de aviões
echo ""
echo "[2] Containers de aviões em execução:"
AVIOES=$(docker ps --filter name=aviao- --format "{{.Names}}" | sort)
if [ -z "$AVIOES" ]; then
  echo "    Nenhum avião em execução."
  exit 0
fi
echo "$AVIOES" | while read a; do echo "    · $a"; done

# 3. Derrubar 3 aviões aleatórios
echo ""
echo "[3] Derrubando 3 aviões aleatoriamente (kill -9)..."
echo "$AVIOES" | shuf | head -3 | while read container; do
  echo "    ✗ Matando: $container"
  docker kill "$container"
  sleep 1
done

# 4. Aguardar e verificar que o sistema continua funcionando
echo ""
echo "[4] Aguardando 5s e verificando sistema..."
sleep 5

if check_server; then
  echo "    ✓ Servidor de aplicação ainda respondendo"
else
  echo "    ✗ FALHA: servidor parou de responder!"
fi

STATUS=$(curl -s http://localhost:4000/status)
echo "    Status: $STATUS" | python3 -c "import sys,json; raw=sys.stdin.read(); d=json.loads(raw.split('Status: ')[1]); print(f'    Voos ativos: {d[\"voosAtivos\"]} | Msgs: {d[\"totalMsgs\"]}')" 2>/dev/null || echo "    (parse error)"

# 5. Verificar Last Will Testament
echo ""
echo "[5] Verificando eventos de desconexão no servidor..."
curl -s http://localhost:4000/eventos | python3 -c "
import sys, json
evts = json.load(sys.stdin)
descon = [e for e in evts if e['evento'] in ('desconectou','emergencia')]
print(f'    {len(descon)} evento(s) de desconexão/emergência registrado(s)')
for e in descon[:5]:
    print(f'    · {e[\"callsign\"]} → {e[\"evento\"]} em {e[\"created_at\"]}')
" 2>/dev/null || echo "    (sem eventos ou erro de parse)"

echo ""
echo "════════════════════════════════════════════════════════"
echo " Teste concluído."
echo " Os containers derrubados têm restart:on-failure e"
echo " serão reiniciados automaticamente pelo Docker."
echo "════════════════════════════════════════════════════════"
