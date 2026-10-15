CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  entry_id TEXT,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  at INTEGER NOT NULL,
  ref TEXT
);

CREATE TABLE IF NOT EXISTS charges (
  charge_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL,
  pricing_tier TEXT NOT NULL,
  region TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS washes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  cycle_units INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_order_idx ON ledger (order_id);
CREATE INDEX IF NOT EXISTS ledger_tenant_idx ON ledger (tenant_id);
CREATE INDEX IF NOT EXISTS ledger_kind_idx ON ledger (kind);
CREATE INDEX IF NOT EXISTS ledger_at_idx ON ledger (at);
CREATE INDEX IF NOT EXISTS charges_order_idx ON charges (order_id, created_at);
CREATE INDEX IF NOT EXISTS charges_payment_ref_idx ON charges (payment_ref, created_at);
CREATE INDEX IF NOT EXISTS webhook_event_idx ON webhook_dedupe (event_id);
CREATE INDEX IF NOT EXISTS operators_op_idx ON operators (operator_id, created_at);
CREATE INDEX IF NOT EXISTS washes_order_idx ON washes (order_id, created_at);