# ✈ AeroTrack BR — Sistema Distribuído de Rastreamento de Aviões
### Projeto de Sistemas Distribuídos · MQTT · Docker · Leaflet · PostgreSQL

---

## Arquitetura

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Docker Network: aerotrack-net                     │
│                                                                          │
│  ┌─────────────────┐  PUBLISH QoS 0/1  ┌──────────────────────────────┐ │
│  │  aviao-LA3105   │ ─────────────────► │                              │ │
│  │  aviao-G31820   │ ─────────────────► │   Eclipse Mosquitto MQTT     │ │
│  │  aviao-AD4490   │ ─────────────────► │   (middleware real)          │ │
│  │  aviao-...      │ ─────────────────► │   porta 1883 (MQTT)          │ │
│  └─────────────────┘                   │   porta 9001 (WS)            │ │
│   1 container = 1 avião                │   wildcards: voo/+/+/tel...  │ │
│   Reconexão com backoff                │   retained messages          │ │
│   Last Will Testament                  │   keepalive 60s              │ │
│                                        └──────────────┬───────────────┘ │
│                                                        │ SUBSCRIBE       │
│                                                        ▼                 │
│                                        ┌───────────────────────────────┐ │
│                                        │  Servidor de Aplicação        │ │
│                                        │  (Node.js)                    │ │
│                                        │  · MQTT subscriber            │ │
│                                        │  · Estado em memória          │ │
│                                        │  · WebSocket fan-out          │ │
│                                        │  · REST API                   │ │
│                                        │  · Persiste no PostgreSQL     │ │
│                                        └──────┬──────────┬─────────────┘ │
│                                               │ WS       │ SQL           │
│                                               ▼          ▼               │
│                                   ┌──────────────┐  ┌──────────────┐    │
│                                   │  Frontend    │  │  PostgreSQL  │    │
│                                   │  (Nginx)     │  │  telemetria  │    │
│                                   │  Leaflet map │  │  eventos     │    │
│                                   └──────────────┘  └──────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Modelos de Sistemas Distribuídos Aplicados

| Modelo | Onde se manifesta |
|--------|-------------------|
| **Pub/Sub baseado em eventos** | Aviões publicam, servidor e frontend assinam sem se conhecerem |
| **Cliente-Servidor Multicamadas** | Frontend → Servidor → Banco (3 camadas clássicas) |
| **Redes de Sensores** | Cada container avião age como nó sensor autônomo |
| **Middleware de mensageria** | Mosquitto abstrai transporte, roteamento e QoS |

---

## Tópicos MQTT e QoS

| Tópico | Publisher | QoS | Retained | Uso |
|--------|-----------|-----|----------|-----|
| `voo/{airline}/{callsign}/telemetria` | Avião | 0 (fire-and-forget) | Sim | Posição em tempo real |
| `voo/eventos` | Avião | 1 (entrega garantida) | Não | Decolagem, pouso, emergência |
| `controle/{callsign}` | Operador | 1 | Não | Comandos remotos |

**Por que QoS 0 para telemetria?**
Posição de 2 segundos atrás não tem valor. Overhead de ACK supera o benefício.

**Por que QoS 1 para eventos?**
Eventos de ciclo de vida (decolou/pousou) não são redundantes — perder um causa inconsistência.

---

## Início Rápido

### Pré-requisitos
- Docker 24+
- Docker Compose v2

```bash
# 1. Clonar / entrar no diretório
cd aerotrack-v2

# 2. Subir tudo
docker-compose up --build

# 3. Acessar
# Mapa:    http://localhost:3000
# API:     http://localhost:4000/status
# MQTT:    mqtt://localhost:1883
```

---

## REST API

| Endpoint | Descrição |
|----------|-----------|
| `GET /status` | Métricas do servidor (voos, msgs, uptime, memória) |
| `GET /voos` | Estado atual de todos os voos em memória |
| `GET /voos/{callsign}` | Estado de um voo específico |
| `GET /historico/{callsign}` | Últimas 100 posições do banco |
| `GET /eventos` | Últimos 50 eventos de ciclo de vida |

---

## Scripts de Teste

```bash
chmod +x scripts/*.sh

# Adicionar avião dinamicamente
./scripts/add-aviao.sh LA9999 LATAM LA GRU POA 1000

# Teste de crash failures (derruba 3 aviões aleatórios)
./scripts/crash-test.sh

# Injetar latência de rede (simula rádio instável)
./scripts/network-delay.sh inject 500ms 100ms 10
./scripts/network-delay.sh remove
./scripts/network-delay.sh status
```

---

## Testes de Sistemas Distribuídos

### 1. Crash Failures
```bash
# Matar um avião abruptamente
docker kill aviao-LA3105

# Observar:
# - Broker recebe o Last Will Testament do avião
# - Servidor remove o voo do estado em memória
# - Frontend exibe evento "desconectou" no log
# - Container reinicia automaticamente (restart: on-failure)
docker logs -f aerotrack-servidor
```

### 2. Falha do Broker
```bash
docker stop aerotrack-broker
# Aviões: tentam reconectar com backoff exponencial
# Servidor: idem — estado em memória preservado
# Frontend: exibe "DESCONECTADO"

docker start aerotrack-broker
# Sistema se recupera automaticamente
```

### 3. Latência de Rede
```bash
./scripts/network-delay.sh inject 1000ms 200ms 20
# Observar timestamps defasados no mapa
# Mensagens com delay visível no log pub/sub
./scripts/network-delay.sh remove
```

### 4. Flash Crowd (múltiplos clientes)
```bash
# Abrir 10+ abas do browser em http://localhost:3000
# Verificar: http://localhost:4000/status -> wsClients
# O servidor deve atender todos via fan-out sem degradar
```

### 5. Snapshot para novos clientes
```bash
# Abrir o mapa depois de 1 minuto
# Todos os aviões aparecem imediatamente (retained messages + snapshot WS)
# Não precisa esperar o próximo tick de cada avião
```

---

## Estrutura do Projeto

```
aerotrack-v2/
├── broker/
│   ├── mosquitto.conf    # Configuração do Eclipse Mosquitto
│   └── Dockerfile
├── aviao/
│   ├── simulator.js      # Publisher MQTT com física de voo
│   ├── package.json
│   └── Dockerfile
├── servidor/
│   ├── server.js         # MQTT subscriber + WS + REST + PostgreSQL
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── index.html        # Leaflet + WebSocket subscriber
│   ├── nginx.conf
│   └── Dockerfile
├── banco/
│   └── init.sql          # Schema PostgreSQL
├── scripts/
│   ├── add-aviao.sh      # Adicionar avião dinamicamente
│   ├── crash-test.sh     # Teste de tolerância a falhas
│   └── network-delay.sh  # Injeção de latência (tc netem)
├── docker-compose.yml
└── README.md
```

---

## Decisões de Projeto (Justificativas Acadêmicas)

| Decisão | Justificativa |
|---------|---------------|
| Mosquitto como broker | Middleware real, não simulado. MQTT é o protocolo padrão de telemetria IoT |
| QoS 0 para telemetria | Dado temporal sem valor retrospectivo; overhead de ACK desnecessário |
| Estado em memória no servidor | Reconstituível em segundos; evita single point of failure no banco |
| Persistência amostrada (1/10 ticks) | Evita write amplification; histórico útil sem sobrecarregar o banco |
| Last Will Testament | Notificação automática de falha sem coordenação explícita |
| Retained messages | Novos subscribers recebem estado atual imediatamente |
| Stateless broker | Facilita restart sem perda de consistência do sistema |
| Sem eleição de líder | Broker centralizado intencional no escopo do projeto |

---

## Evolução para Produção

```
Atual (projeto):          Produção:
Mosquitto único     →     EMQX Cluster (HA) ou HiveMQ
PostgreSQL          →     TimescaleDB (hypertable por tempo)
Node.js single      →     Cluster mode + load balancer
Docker local        →     Kubernetes (HPA por número de voos)
Dados simulados     →     OpenSky Network API / receptores SDR
```
