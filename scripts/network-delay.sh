#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  AeroTrack BR — Injeção de Latência de Rede
#
#  Simula conexões de rádio intermitentes entre aviões e broker.
#  Usa tc (traffic control) do Linux para adicionar delay e packet loss.
#
#  Uso:
#    ./scripts/network-delay.sh inject   # injeta 500ms + 10% perda
#    ./scripts/network-delay.sh remove   # remove restrições
#    ./scripts/network-delay.sh status   # mostra configuração atual
# ─────────────────────────────────────────────────────────────────────────────

ACTION=${1:-inject}
DELAY=${2:-500ms}
JITTER=${3:-100ms}
LOSS=${4:-10}

echo "════════════════════════════════════════════════════════"
echo " AeroTrack BR — Injeção de Latência de Rede"
echo " Ação: $ACTION | Delay: $DELAY±$JITTER | Perda: ${LOSS}%"
echo "════════════════════════════════════════════════════════"

AVIOES=$(docker ps --filter name=aviao- --format "{{.Names}}" | sort)

case "$ACTION" in
  inject)
    echo ""
    echo "Injetando latência nos containers de aviões..."
    echo "$AVIOES" | while read container; do
      # Executar tc dentro do container
      docker exec "$container" sh -c "
        apk add --quiet iproute2 2>/dev/null || true
        tc qdisc del dev eth0 root 2>/dev/null || true
        tc qdisc add dev eth0 root netem delay ${DELAY} ${JITTER} loss ${LOSS}%
        echo '✓ ${container}: delay=${DELAY} jitter=${JITTER} loss=${LOSS}%'
      " 2>/dev/null || echo "  ⚠ $container: não foi possível injetar (sem CAP_NET_ADMIN?)"
    done

    echo ""
    echo "Observar efeitos:"
    echo "  · Mapa deve congelar brevemente e retomar"
    echo "  · Mensagens com timestamp defasado no log"
    echo "  · Reconexões visíveis nos logs: docker logs -f aviao-LA3105"
    ;;

  remove)
    echo ""
    echo "Removendo restrições de rede..."
    echo "$AVIOES" | while read container; do
      docker exec "$container" sh -c "
        tc qdisc del dev eth0 root 2>/dev/null && echo '✓ ${container}: restrições removidas' || echo '  ${container}: nada a remover'
      " 2>/dev/null || true
    done
    ;;

  status)
    echo ""
    echo "$AVIOES" | while read container; do
      echo "--- $container ---"
      docker exec "$container" tc qdisc show dev eth0 2>/dev/null || echo "  (inacessível)"
    done
    ;;

  *)
    echo "Uso: $0 [inject|remove|status] [delay] [jitter] [loss%]"
    exit 1
    ;;
esac

echo ""
echo "Feito."
