CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS charges (
  order_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payment_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_dedupe (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operators (
  operator_id TEXT PRIMARY KEY,
  pricing_tier TEXT NOT NULL,
  region TEXT NOT NULL,
  currency TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS washes (
  order_id TEXT PRIMARY KEY,
  cycle_units INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_order_idx ON ledger (order_id);
CREATE INDEX IF NOT EXISTS charges_order_idx ON charges (order_id);
CREATE INDEX IF NOT EXISTS webhook_event_idx ON webhook_dedupe (event_id);
CREATE INDEX IF NOT EXISTS operators_tier_idx ON operators (pricing_tier);
CREATE INDEX IF NOT EXISTS washes_cycle_idx ON washes (cycle_units);
CREATE INDEX IF NOT EXISTS ledger_tenant_idx ON ledger (tenant_id);