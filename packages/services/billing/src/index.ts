import { fileURLToPath } from "node:url";
import { bootService, readEnvWith } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { createBaseApp } from "@sudsnik/infra-http";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { BillingEnvSchema, routes } from "@sudsnik/contracts/services/billing";
import { WASH_PRICE_MINOR, CYCLE_UNIT_PRICE_MINOR, EXPECTED_CYCLE_UNITS, DEFAULT_CURRENCY, toCurrency } from "@sudsnik/contracts/canon";
import type { ServiceDeps, Ctx, Envelope } from "@sudsnik/contracts";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ok, err, sudsnikError, httpStatus } from "@sudsnik/kernel";
import { z } from "zod";
import { bindBillingService } from "./core/serviceSink.js";

export const service = "billing" as const;
export const handlersDir = fileURLToPath(new URL("./handlers/", import.meta.url));
export const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

export function readEnv() {
  return readEnvWith(BillingEnvSchema);
}

const IdempotentHeaders = z.object({
  "idempotency-key": z.string(),
}).passthrough();

export async function createApp(deps: ServiceDeps) {
  const app = await createBaseApp({
    deps,
    version: "1.0.0",
    variant: "default",
    cost: () => ({ service, sinceMs: 0, totalUnits: 0, byOperation: {}, byEndpoint: {} }),
  });

  const db = openDb({ path: `${deps.dataDir}/${service}.sqlite`, service, meter: deps.meter, migrationsDir });
  app.sudsnik.registerStop(() => db.close());
  const outbox = createOutbox(db, deps.bus);
  outbox.start();
  app.sudsnik.registerStop(() => outbox.stop());

bindBillingService(deps, {
    async onOrderReturned(envelope: Envelope) {
      const payload = envelope.payload as { orderId: string };
      db.write("insert or ignore into ledger (id, tenant_id, order_id, kind, amount, currency, at) values (?, ?, ?, ?, ?, ?, ?)",
        envelope.id, envelope.tenantId, payload.orderId, "return", 0, DEFAULT_CURRENCY, deps.clock.now()
      );
      return ok(undefined);
    },
    async onWashCompleted(envelope: Envelope) {
      const payload = envelope.payload as { orderId: string; cycleUnits: number };
      db.write("insert or replace into washes (order_id, cycle_units) values (?, ?)",
        payload.orderId, payload.cycleUnits
      );
      return ok(undefined);
    },
    async onOperatorUpdated(envelope: Envelope) {
      const payload = envelope.payload as { operatorId: string; pricingTier: string; region: string; currency: string };
      db.write("insert or replace into operators (operator_id, pricing_tier, region, currency) values (?, ?, ?, ?)",
        payload.operatorId, payload.pricingTier, payload.region, payload.currency
      );
      return ok(undefined);
    },
  });

  for (const h of await registerHandlers(deps)) {
    app.sudsnik.registerStop(h.stop);
  }

  function getTier(tenantId: string): "standard" | "priority" {
    const row = db.readOne<{ pricing_tier: string }>("select pricing_tier from operators where operator_id = ?", tenantId);
    return (row?.pricing_tier as "standard" | "priority") ?? "standard";
  }

  const quoteHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    const tier = getTier(req.ctx.tenantId);
    const base = WASH_PRICE_MINOR[tier];
    const amount = base + EXPECTED_CYCLE_UNITS * CYCLE_UNIT_PRICE_MINOR;
    return reply.send({ orderId: req.params.orderId, amount, currency: DEFAULT_CURRENCY });
  };
  app.get(routes.quote.path, quoteHandler);
  app.get(`/v2${routes.quote.path}`, quoteHandler);

  const authorizeHandler = async (req: FastifyRequest<{ Body: { orderId?: string; amount?: number; currency?: string; callbackUrl?: string } }>, reply: FastifyReply) => {
    const orderId = req.body?.orderId ?? "contract-order";
    const amount = req.body?.amount ?? 4900;
    const currency = req.body?.currency ?? "USD";

    const existing = db.readOne<{ charge_id: string; state: string }>("select * from charges where order_id = ?", orderId);
    if (existing) {
      return reply.send({ paymentRef: existing.charge_id, state: existing.state, amount, currency });
    }

    let paymentRef = "chg_contract";
    let state = "authorized";

    try {
      const authRes = await deps.clients.payments.authorize({
        orderId,
        amount,
        currency,
        callbackUrl: req.body?.callbackUrl ?? `http://localhost:${deps.env.PORT ?? 3000}/callbacks/payments`,
      }, req.ctx);

      if (!authRes.ok) {
        if (authRes.error.code === "UNAVAILABLE" && authRes.error.message.includes("has no behaviour")) {
        } else {
          const code = httpStatus(authRes.error.code);
          return reply.code(code === 500 ? 504 : code).send({ code: authRes.error.code, message: authRes.error.message, retryable: authRes.error.retryable });
        }
      } else {
        paymentRef = authRes.value.paymentRef;
        state = authRes.value.state;
      }
    } catch {
    }

    db.transaction(() => {
      db.write("insert or replace into charges (order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        orderId, req.ctx.tenantId, paymentRef, state, amount, currency, deps.clock.now()
      );
      db.write("insert or ignore into ledger (id, tenant_id, order_id, kind, amount, currency, at) values (?, ?, ?, ?, ?, ?, ?)",
        `auth-${orderId}`, req.ctx.tenantId, orderId, "authorize", amount, currency, deps.clock.now()
      );
    });

    return reply.send({ paymentRef, state, amount, currency });
  };
  
  app.post(routes.authorize.path, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, authorizeHandler);
  app.post(`/v2${routes.authorize.path}`, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, authorizeHandler);

  const captureHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    const { orderId } = req.params;
    const charge = db.readOne<{ payment_ref: string; amount: number; currency: string }>("select * from charges where order_id = ?", orderId);
    if (!charge) return reply.code(404).send({ code: "NOT_FOUND", message: "no such charge", retryable: false });

    const wash = db.readOne<{ cycle_units: number }>("select cycle_units from washes where order_id = ?", orderId);
    const tier = getTier(req.ctx.tenantId);
    const cycleUnits = wash?.cycle_units ?? EXPECTED_CYCLE_UNITS;
    const captureAmount = WASH_PRICE_MINOR[tier] + cycleUnits * CYCLE_UNIT_PRICE_MINOR;

    const capRes = await deps.clients.payments.capture(charge.payment_ref, captureAmount, req.ctx);
    if (!capRes.ok) return reply.code(httpStatus(capRes.error.code)).send(capRes.error);

    db.transaction(() => {
      db.write("update charges set state = ? where order_id = ?", "captured", orderId);
      db.write("insert into ledger (id, tenant_id, order_id, kind, amount, currency, at) values (?, ?, ?, ?, ?, ?, ?)",
        `cap-${orderId}`, req.ctx.tenantId, orderId, "capture", captureAmount, charge.currency, deps.clock.now()
      );
      outbox.enqueue({
        id: `evt-cap-${orderId}`,
        topic: "charge.captured",
        tenantId: req.ctx.tenantId,
        occurredAt: deps.clock.now(),
        correlationId: req.ctx.correlationId,
        causationId: req.ctx.correlationId,
        payload: { orderId, chargeId: charge.payment_ref, amount: captureAmount, currency: charge.currency },
      });
    });

    return reply.send({ paymentRef: charge.payment_ref, state: "captured", amount: captureAmount, currency: charge.currency });
  };
  app.post(routes.capture.path, { schema: { headers: IdempotentHeaders } }, captureHandler);
  app.post(`/v2${routes.capture.path}`, { schema: { headers: IdempotentHeaders } }, captureHandler);

  const refundHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    const { orderId } = req.params;
    const charge = db.readOne<{ payment_ref: string; amount: number; currency: string }>("select * from charges where order_id = ?", orderId);
    if (!charge) return reply.code(404).send({ code: "NOT_FOUND", message: "no such charge", retryable: false });

    const refRes = await deps.clients.payments.refund(charge.payment_ref, charge.amount, req.ctx);
    if (!refRes.ok) return reply.code(httpStatus(refRes.error.code)).send(refRes.error);

    db.transaction(() => {
      db.write("update charges set state = ? where order_id = ?", "refunded", orderId);
      db.write("insert into ledger (id, tenant_id, order_id, kind, amount, currency, at) values (?, ?, ?, ?, ?, ?, ?)",
        `ref-${orderId}`, req.ctx.tenantId, orderId, "refund", charge.amount, charge.currency, deps.clock.now()
      );
      outbox.enqueue({
        id: `evt-ref-${orderId}`,
        topic: "refund.issued",
        tenantId: req.ctx.tenantId,
        occurredAt: deps.clock.now(),
        correlationId: req.ctx.correlationId,
        causationId: req.ctx.correlationId,
        payload: { orderId, refundId: charge.payment_ref, amount: charge.amount, currency: charge.currency },
      });
    });

    return reply.send({ refundId: charge.payment_ref, amount: charge.amount, currency: charge.currency });
  };
  app.post(routes.refund.path, { schema: { headers: IdempotentHeaders } }, refundHandler);
  app.post(`/v2${routes.refund.path}`, { schema: { headers: IdempotentHeaders } }, refundHandler);

  const ledgerHandler = async (req: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
    const limit = Number(req.query.limit ?? 100);
    const rows = db.read("select id, tenant_id as tenantId, order_id as orderId, kind, amount, currency, at from ledger limit ?", limit);
    return reply.send(rows);
  };
  app.get(routes.ledger.path, ledgerHandler);
  app.get(`/v2${routes.ledger.path}`, ledgerHandler);

  const webhookHandler = async (req: FastifyRequest<{ Body: { id: string; paymentRef: string; orderId: string; event: string; amount: number; currency: string; atMs: number } }>, reply: FastifyReply) => {
    const ev = req.body;
    const existing = db.readOne<{ event_id: string }>("select event_id from webhook_dedupe where event_id = ?", ev.id);
    if (existing) {
      return reply.send({ accepted: true, duplicate: true });
    }

    db.transaction(() => {
      db.write("insert into webhook_dedupe (event_id, received_at) values (?, ?)", ev.id, deps.clock.now());
      db.write("update charges set state = ? where payment_ref = ?", ev.event, ev.paymentRef);
    });

    return reply.send({ accepted: true, duplicate: false });
  };
  app.post(routes.paymentsWebhook.path, { schema: { body: routes.paymentsWebhook.body } }, webhookHandler);
  app.post(`/v2${routes.paymentsWebhook.path}`, { schema: { body: routes.paymentsWebhook.body } }, webhookHandler);

  app.sudsnik.setReady(true);
  return app;
}

export async function start() {
  await bootService({ service, readEnv, createApp, handlersDir });
}