-- ============================================================================
-- MONEY ENGINE — DATABASE SCHEMA (PostgreSQL)
-- ============================================================================
-- Run this ONCE against the Postgres that n8n already uses, or a fresh one.
--   psql -U n8n -d n8n -f schema.sql
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS money;

-- ---------------------------------------------------------------------------
-- Raw transaction feed from the open-banking provider.
-- Append-only. Never updated, never deleted. The provider is the source of
-- truth; this is our local mirror so detection doesn't re-hit the API.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money.transactions (
    id                  BIGSERIAL PRIMARY KEY,
    provider_tx_id      TEXT        NOT NULL,
    account_id          TEXT        NOT NULL,
    booked_at           DATE        NOT NULL,
    amount_gbp          NUMERIC(12,2) NOT NULL,   -- negative = money out
    currency            TEXT        NOT NULL DEFAULT 'GBP',
    raw_description     TEXT        NOT NULL,
    merchant_key        TEXT        NOT NULL,     -- normalised, for grouping
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The provider re-sends recent transactions on every poll. This is what
    -- makes the daily sync idempotent.
    CONSTRAINT uq_provider_tx UNIQUE (account_id, provider_tx_id)
);

CREATE INDEX IF NOT EXISTS ix_tx_merchant  ON money.transactions (merchant_key, booked_at DESC);
CREATE INDEX IF NOT EXISTS ix_tx_booked    ON money.transactions (booked_at DESC);
CREATE INDEX IF NOT EXISTS ix_tx_account   ON money.transactions (account_id, booked_at DESC);

-- ---------------------------------------------------------------------------
-- Latest known balance per account. Overwritten each sync — we only care
-- about "now" for the idle-cash check.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money.balances (
    account_id          TEXT        PRIMARY KEY,
    account_label       TEXT,
    balance_gbp         NUMERIC(12,2) NOT NULL,
    -- What this account actually pays. Set manually once; the engine can't
    -- read your interest rate from the API.
    interest_rate_pct   NUMERIC(5,2)  NOT NULL DEFAULT 0.00,
    is_current_account  BOOLEAN     NOT NULL DEFAULT true,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Detected recurring payments. This table IS the subscription radar's memory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money.subscriptions (
    merchant_key        TEXT        PRIMARY KEY,
    display_name        TEXT        NOT NULL,
    typical_amount_gbp  NUMERIC(12,2) NOT NULL,
    interval_days       INTEGER     NOT NULL,
    occurrences         INTEGER     NOT NULL,
    first_seen          DATE        NOT NULL,
    last_charged        DATE        NOT NULL,
    annual_cost_gbp     NUMERIC(12,2) NOT NULL,

    -- Lifecycle: active | dormant | cancelled_by_user | ignored
    status              TEXT        NOT NULL DEFAULT 'active',

    -- Set when the engine has already told you about this one, so it doesn't
    -- tell you again every single week. This is the anti-nag mechanism.
    alerted_at          TIMESTAMPTZ,
    alert_kind          TEXT,       -- new | price_rise | trial_converted | dormant

    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_subs_status ON money.subscriptions (status, annual_cost_gbp DESC);

-- ---------------------------------------------------------------------------
-- The action queue. Everything the engine wants you to do lands here.
-- The digest reads from this table; it never invents items on the fly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money.actions (
    id                  BIGSERIAL PRIMARY KEY,

    -- Stable key so the same finding never queues twice.
    dedupe_key          TEXT        NOT NULL UNIQUE,

    source              TEXT        NOT NULL,  -- leak_radar | idle_cash | claims | capital
    title               TEXT        NOT NULL,
    detail              TEXT,
    action_url          TEXT,

    -- Drives ordering and the noise floor. This is the whole ranking model.
    annual_value_gbp    NUMERIC(12,2) NOT NULL DEFAULT 0,
    minutes_required    INTEGER     NOT NULL DEFAULT 10,

    -- open | sent | done | dismissed | expired
    status              TEXT        NOT NULL DEFAULT 'open',

    -- Some actions have a real-world cliff (ISA deadline, insurance renewal).
    due_date            DATE,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at             TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_actions_open
    ON money.actions (status, annual_value_gbp DESC)
    WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Money actually banked. The scoreboard.
-- Nothing reads this except you — but seeing the number climb is the thing
-- that keeps you engaging with the system, so it earns its place.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money.wins (
    id                  BIGSERIAL PRIMARY KEY,
    action_id           BIGINT REFERENCES money.actions(id),
    description         TEXT        NOT NULL,
    -- One-off gain (a switch bonus, a backdated claim).
    one_off_gbp         NUMERIC(12,2) NOT NULL DEFAULT 0,
    -- Ongoing gain (a cancelled sub, a better savings rate).
    annual_gbp          NUMERIC(12,2) NOT NULL DEFAULT 0,
    banked_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Running total, for the digest footer.
CREATE OR REPLACE VIEW money.scoreboard AS
SELECT
    COALESCE(SUM(one_off_gbp), 0)                        AS total_one_off_gbp,
    COALESCE(SUM(annual_gbp), 0)                         AS total_annual_gbp,
    COALESCE(SUM(one_off_gbp), 0)
        + COALESCE(SUM(annual_gbp), 0)                   AS first_year_total_gbp,
    COUNT(*)                                             AS wins_count
FROM money.wins;

-- ---------------------------------------------------------------------------
-- Sync bookkeeping, so a failed run doesn't silently do nothing forever.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money.sync_log (
    id                  BIGSERIAL PRIMARY KEY,
    workflow            TEXT        NOT NULL,
    ran_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok                  BOOLEAN     NOT NULL,
    rows_ingested       INTEGER     NOT NULL DEFAULT 0,
    message             TEXT
);

CREATE INDEX IF NOT EXISTS ix_sync_recent ON money.sync_log (workflow, ran_at DESC);
