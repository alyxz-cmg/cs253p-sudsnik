import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const ledger = sqliteTable('ledger', {
  entryId: text('entry_id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  orderId: text('order_id').notNull(),
  kind: text('kind').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  at: integer('at').notNull(),
  ref: text('ref'),
});