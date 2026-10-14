CREATE TABLE `ledger` (
  `entry_id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `order_id` text NOT NULL,
  `kind` text NOT NULL,
  `amount` integer NOT NULL,
  `currency` text NOT NULL,
  `at` integer NOT NULL,
  `ref` text
);