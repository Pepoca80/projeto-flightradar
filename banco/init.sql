-- Schema Cassandra do Projeto.
CREATE KEYSPACE IF NOT EXISTS usp_airlines
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS usp_airlines.telemetria_by_callsign (
    callsign    text,
    ts          bigint,
    id          timeuuid,
    airline     text,
    origin      text,
    destination text,
    lat         double,
    lng         double,
    altitude    int,
    speed       int,
    heading     int,
    phase       text,
    progress    double,
    created_at  timestamp,
    PRIMARY KEY ((callsign), ts, id)
) WITH CLUSTERING ORDER BY (ts DESC, id DESC);

CREATE TABLE IF NOT EXISTS usp_airlines.eventos_latest (
    bucket      text,
    created_at  timestamp,
    id          timeuuid,
    callsign    text,
    evento      text,
    payload     text,
    PRIMARY KEY ((bucket), created_at, id)
) WITH CLUSTERING ORDER BY (created_at DESC, id DESC);