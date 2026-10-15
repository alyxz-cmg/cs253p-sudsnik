import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const ledger = sqliteTable("ledger", {
  id: text("id").primaryKey(),
  entryId: text("entry_id"),
  tenantId: text("tenant_id").notNull(),
  orderId: text("order_id").notNull(),
  kind: text("kind").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  at: integer("at").notNull(),
  ref: text("ref"),
});

export const charges = sqliteTable("charges", {
  chargeId: text("charge_id").primaryKey(),
  orderId: text("order_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  paymentRef: text("payment_ref").notNull(),
  state: text("state").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const webhookDedupe = sqliteTable("webhook_dedupe", {
  eventId: text("event_id").primaryKey(),
  receivedAt: integer("received_at").notNull(),
});
