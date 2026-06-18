-- AeroTrack BR — Inicialização do banco de dados
-- Compatível com PostgreSQL 15+ e TimescaleDB

CREATE DATABASE aerotrack;

\c aerotrack;

-- Tabela de telemetria (posições dos aviões)
CREATE TABLE IF NOT EXISTS telemetria (
    id          BIGSERIAL PRIMARY KEY,
    callsign    VARCHAR(16)      NOT NULL,
    airline     VARCHAR(64),
    origin      VARCHAR(4),
    destination VARCHAR(4),
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    altitude    INTEGER,
    speed       INTEGER,
    heading     INTEGER,
    phase       VARCHAR(16),
    progress    DOUBLE PRECISION,
    ts          BIGINT,
    created_at  TIMESTAMPTZ      DEFAULT NOW()
);

-- Tabela de eventos de ciclo de vida
CREATE TABLE IF NOT EXISTS eventos (
    id         BIGSERIAL PRIMARY KEY,
    callsign   VARCHAR(16) NOT NULL,
    evento     VARCHAR(32) NOT NULL,
    payload    JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tel_callsign   ON telemetria(callsign);
CREATE INDEX IF NOT EXISTS idx_tel_ts         ON telemetria(ts DESC);
CREATE INDEX IF NOT EXISTS idx_tel_cs_ts      ON telemetria(callsign, ts DESC);
CREATE INDEX IF NOT EXISTS idx_evt_callsign   ON eventos(callsign);
CREATE INDEX IF NOT EXISTS idx_evt_tipo       ON eventos(evento);

-- Usuário da aplicação
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aerotrack') THEN
    CREATE ROLE aerotrack LOGIN PASSWORD 'aerotrack';
  END IF;
END$$;

GRANT ALL PRIVILEGES ON DATABASE aerotrack TO aerotrack;
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO aerotrack;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO aerotrack;
