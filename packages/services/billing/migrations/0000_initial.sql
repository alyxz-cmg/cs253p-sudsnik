CREATE TABLE IF NOT EXISTS `ledger` (
  `entry_id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `order_id` text NOT NULL,
  `kind` text NOT NULL,
  `amount` integer NOT NULL,
  `currency` text NOT NULL,
  `at` integer NOT NULL,
  `ref` text
);

CREATE TABLE IF NOT EXISTS `charges` (
  `charge_id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `order_id` text NOT NULL,
  `payment_ref` text,
  `state` text NOT NULL,
  `amount` integer NOT NULL,
  `currency` text NOT NULL,
  `created_at` integer NOT NULL
);

CREATE TABLE IF NOT EXISTS `webhook_dedupe` (
  `event_id` text PRIMARY KEY NOT NULL,
  `received_at` integer NOT NULL
);

CREATE INDEX IF NOT EXISTS `ledger_order_idx` ON `ledger` (`order_id`);
CREATE INDEX IF NOT EXISTS `charges_order_idx` ON `charges` (`order_id`);