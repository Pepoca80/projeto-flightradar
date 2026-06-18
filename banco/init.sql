-- Banco de Dados

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

CREATE TABLE IF NOT EXISTS eventos (
    id         BIGSERIAL PRIMARY KEY,
    callsign   VARCHAR(16) NOT NULL,
    evento     VARCHAR(32) NOT NULL,
    payload    JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tel_callsign   ON telemetria(callsign);
CREATE INDEX IF NOT EXISTS idx_tel_ts         ON telemetria(ts DESC);
CREATE INDEX IF NOT EXISTS idx_tel_cs_ts      ON telemetria(callsign, ts DESC);
CREATE INDEX IF NOT EXISTS idx_evt_callsign   ON eventos(callsign);
CREATE INDEX IF NOT EXISTS idx_evt_tipo       ON eventos(evento);