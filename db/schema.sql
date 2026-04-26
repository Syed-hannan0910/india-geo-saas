-- ============================================================
-- India Geo SaaS – Master Database Schema
-- Target: NeonDB (PostgreSQL 16+)
-- Goal: <100ms p95 for all API endpoints at 1M+ req/day
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- Trigram fuzzy search
CREATE EXTENSION IF NOT EXISTS unaccent;       -- Accent-insensitive search
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- UUID generation

-- ─── Immutable Search Configuration ────────────────────────────────────────
CREATE TEXT SEARCH CONFIGURATION public.india_search (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION india_search
    ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;

-- ============================================================
-- GEOGRAPHICAL HIERARCHY
-- ============================================================

CREATE TABLE states (
    id              SERIAL PRIMARY KEY,
    code            CHAR(2)      NOT NULL UNIQUE,   -- MDDS STC (2-digit)
    name            VARCHAR(100) NOT NULL,
    normalized_name VARCHAR(100) NOT NULL,           -- lowercase, unaccented
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE districts (
    id              SERIAL PRIMARY KEY,
    state_id        INTEGER      NOT NULL REFERENCES states(id) ON DELETE CASCADE,
    code            CHAR(3)      NOT NULL,           -- MDDS DTC (3-digit)
    name            VARCHAR(150) NOT NULL,
    normalized_name VARCHAR(150) NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (state_id, code)
);

CREATE TABLE sub_districts (
    id              SERIAL PRIMARY KEY,
    district_id     INTEGER      NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    code            CHAR(5)      NOT NULL,           -- MDDS Sub_DT (5-digit)
    name            VARCHAR(150) NOT NULL,
    normalized_name VARCHAR(150) NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (district_id, code)
);

CREATE TABLE villages (
    id                BIGSERIAL    PRIMARY KEY,
    sub_district_id   INTEGER      NOT NULL REFERENCES sub_districts(id) ON DELETE CASCADE,
    code              CHAR(6)      NOT NULL,          -- MDDS PLCN (6-digit)
    name              VARCHAR(200) NOT NULL,
    normalized_name   VARCHAR(200) NOT NULL,
    full_address      TEXT         NOT NULL,          -- Pre-computed for fast API response
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Performance Indexes ────────────────────────────────────────────────────

-- B-tree for hierarchy traversal (the hot path: district→sub_district→village)
CREATE INDEX idx_districts_state        ON districts(state_id);
CREATE INDEX idx_sub_districts_district ON sub_districts(district_id);
CREATE INDEX idx_villages_sub_district  ON villages(sub_district_id);

-- Unique code lookups (state/district/village code searches)
CREATE INDEX idx_states_code       ON states(code);
CREATE INDEX idx_districts_code    ON districts(code);
CREATE INDEX idx_sub_districts_code ON sub_districts(code);
CREATE INDEX idx_villages_code     ON villages(code);

-- Trigram indexes for ILIKE / autocomplete (fuzzy name search)
CREATE INDEX idx_states_name_trgm       ON states       USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX idx_districts_name_trgm    ON districts    USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX idx_sub_districts_name_trgm ON sub_districts USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX idx_villages_name_trgm     ON villages     USING GIN (normalized_name gin_trgm_ops);
CREATE INDEX idx_villages_address_trgm  ON villages     USING GIN (full_address gin_trgm_ops);

-- FTS index for full-text autocomplete search
CREATE INDEX idx_villages_fts ON villages USING GIN (
    to_tsvector('india_search', normalized_name || ' ' || full_address)
);

-- ─── Materialized View: Village Full Hierarchy ──────────────────────────────
-- Pre-joins the entire 4-level hierarchy for instant dropdown population.
-- Refresh nightly or on data update (CONCURRENTLY - zero downtime).
CREATE MATERIALIZED VIEW village_hierarchy AS
SELECT
    v.id              AS village_id,
    v.code            AS village_code,
    v.name            AS village_name,
    v.normalized_name AS village_normalized,
    v.full_address,
    sd.id             AS sub_district_id,
    sd.code           AS sub_district_code,
    sd.name           AS sub_district_name,
    d.id              AS district_id,
    d.code            AS district_code,
    d.name            AS district_name,
    s.id              AS state_id,
    s.code            AS state_code,
    s.name            AS state_name
FROM villages v
JOIN sub_districts sd ON v.sub_district_id = sd.id
JOIN districts d      ON sd.district_id    = d.id
JOIN states s         ON d.state_id        = s.id
WITH DATA;

CREATE UNIQUE INDEX idx_vh_village_id    ON village_hierarchy(village_id);
CREATE INDEX idx_vh_state               ON village_hierarchy(state_id);
CREATE INDEX idx_vh_district            ON village_hierarchy(district_id);
CREATE INDEX idx_vh_sub_district        ON village_hierarchy(sub_district_id);
CREATE INDEX idx_vh_village_code        ON village_hierarchy(village_code);
CREATE INDEX idx_vh_normalized_trgm     ON village_hierarchy USING GIN (village_normalized gin_trgm_ops);

-- ============================================================
-- SAAS PLATFORM TABLES
-- ============================================================

CREATE TYPE user_role AS ENUM ('admin', 'client');
CREATE TYPE plan_tier  AS ENUM ('free', 'premium', 'pro', 'unlimited');

CREATE TABLE users (
    id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(200),
    company_name  VARCHAR(200),
    role          user_role    NOT NULL DEFAULT 'client',
    plan          plan_tier    NOT NULL DEFAULT 'free',
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    is_verified   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE api_keys (
    id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_prefix    CHAR(8)      NOT NULL,              -- Public prefix (e.g. "igk_AbCd")
    key_hash      VARCHAR(64)  NOT NULL UNIQUE,       -- SHA-256 hash of full key
    name          VARCHAR(100) NOT NULL DEFAULT 'Default',
    plan          plan_tier    NOT NULL DEFAULT 'free',
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    last_used_at  TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_user   ON api_keys(user_id);
CREATE INDEX idx_api_keys_hash   ON api_keys(key_hash);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- Plan quotas lookup
CREATE TABLE plan_quotas (
    plan             plan_tier  PRIMARY KEY,
    daily_requests   INTEGER    NOT NULL,   -- -1 = unlimited
    rpm              INTEGER    NOT NULL,   -- requests per minute
    search_results   INTEGER    NOT NULL,   -- max results per search query
    price_monthly    NUMERIC(10,2) NOT NULL DEFAULT 0
);

INSERT INTO plan_quotas VALUES
    ('free',      1000,    10,  10,   0.00),
    ('premium',   50000,   60,  50,  29.99),
    ('pro',      500000,  300, 100,  99.99),
    ('unlimited',     -1, 1000, 200, 299.99);

-- Usage tracking (time-series, partition by month in production)
CREATE TABLE usage_logs (
    -- 1. Change BIGSERIAL to BIGINT to separate the type from the constraint
    id            BIGINT       NOT NULL, 
    api_key_id    UUID         NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    endpoint      VARCHAR(100) NOT NULL,
    method        CHAR(6)      NOT NULL DEFAULT 'GET',
    status_code   SMALLINT     NOT NULL,
    latency_ms    INTEGER      NOT NULL,
    cache_hit     BOOLEAN      NOT NULL DEFAULT FALSE,
    ip_address    INET,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    
    -- 2. Define the Composite Primary Key including the partition key
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions for current and next month
CREATE TABLE usage_logs_2024_01 PARTITION OF usage_logs
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE usage_logs_2024_02 PARTITION OF usage_logs
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE usage_logs_default PARTITION OF usage_logs DEFAULT;

CREATE INDEX idx_usage_api_key_time ON usage_logs(api_key_id, created_at DESC);
CREATE INDEX idx_usage_created      ON usage_logs(created_at DESC);

-- Daily usage aggregates (maintained by trigger for O(1) quota checks)
CREATE TABLE daily_usage (
    api_key_id  UUID        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    usage_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
    request_count INTEGER   NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, usage_date)
);

CREATE INDEX idx_daily_usage_key_date ON daily_usage(api_key_id, usage_date);

-- Function to increment daily usage counter
CREATE OR REPLACE FUNCTION increment_daily_usage(p_key_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO daily_usage (api_key_id, usage_date, request_count)
    VALUES (p_key_id, CURRENT_DATE, 1)
    ON CONFLICT (api_key_id, usage_date)
    DO UPDATE SET request_count = daily_usage.request_count + 1;
END;
$$ LANGUAGE plpgsql;

-- Webhook configurations for client notifications
CREATE TABLE webhooks (
    id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url         TEXT         NOT NULL,
    events      TEXT[]       NOT NULL DEFAULT ARRAY['quota.warning', 'key.expired'],
    secret      VARCHAR(64)  NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Initial Admin User (password: change_me_immediately) ─────────────────
-- Password hash is bcrypt of 'admin_change_me_2024!'
INSERT INTO users (email, password_hash, full_name, role, plan, is_active, is_verified)
VALUES (
    'admin@india-geo.io',
    '$2b$12$placeholder_hash_replace_on_first_boot',
    'Platform Admin',
    'admin',
    'unlimited',
    TRUE,
    TRUE
);
