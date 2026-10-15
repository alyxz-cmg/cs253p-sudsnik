import { fileURLToPath } from "node:url";
import { bootService, readEnvWith } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { createBaseApp } from "@sudsnik/infra-http";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { BillingEnvSchema, routes } from "@sudsnik/contracts/services/billing";
import {
  WASH_PRICE_MINOR,
  CYCLE_UNIT_PRICE_MINOR,
  EXPECTED_CYCLE_UNITS,
  DEFAULT_CURRENCY,
} from "@sudsnik/contracts/canon";
import { makeEnvelope, type ServiceDeps, type Envelope, type Ctx } from "@sudsnik/contracts";
import type { FastifyRequest, FastifyReply } from "fastify";
import { newId, ok, httpStatus } from "@sudsnik/kernel";
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

type ChargeRow = {
  charge_id: string;
  order_id: string;
  tenant_id: string;
  payment_ref: string;
  state: string;
  amount: number;
  currency: string;
  created_at: number;
};

type LedgerRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  kind: "authorize" | "capture" | "refund" | "fee";
  amount: number;
  currency: string;
  at: number;
  ref: string | null;
};

export async function createApp(deps: ServiceDeps) {
  const app = await createBaseApp({
    deps,
    version: "1.0.0",
    variant: "default",
    cost: () => ({ service, sinceMs: 0, totalUnits: 0, byOperation: {}, byEndpoint: {} }),
  });

  const db = openDb({
    path: `${deps.dataDir}/${service}.sqlite`,
    service,
    meter: deps.meter,
    migrationsDir,
  });

  const outbox = createOutbox(db, deps.bus);
  outbox.start();

  app.sudsnik.registerStop(async () => {
    await outbox.stop();
    db.close();
  });

  const toChargeResponse = (row: ChargeRow) => ({
    chargeId: row.payment_ref || row.charge_id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    amount: row.amount,
    currency: row.currency,
    state: row.state as "authorized" | "captured" | "failed" | "refunded",
    ...(row.payment_ref ? { paymentRef: row.payment_ref } : {}),
    updatedAt: row.created_at,
  });

  const getOperator = (tenantId: string) => {
    const row = db.readOne<{ pricing_tier: string; currency: string }>(
      "select pricing_tier, currency from operators where operator_id = ? order by created_at desc, rowid desc limit 1",
      tenantId,
    );
    const tier = (row?.pricing_tier as "standard" | "priority") ?? "standard";
    const currency = row?.currency && row.currency.length === 3 ? row.currency : DEFAULT_CURRENCY;
    return { tier, currency };
  };

  const quoteForOrder = (orderId: string, tenantId: string) => {
    const wash = db.readOne<{ cycle_units: number }>(
      "select cycle_units from washes where order_id = ? order by created_at desc, rowid desc limit 1",
      orderId,
    );
    const cycleUnits = wash?.cycle_units ?? EXPECTED_CYCLE_UNITS;
    const { tier, currency } = getOperator(tenantId);
    const base = WASH_PRICE_MINOR[tier];
    const amount = base + cycleUnits * CYCLE_UNIT_PRICE_MINOR;
    return { orderId, amount, currency, breakdown: { base, cycleUnits, tier } };
  };

  const handleIdempotentRequest = async (req: FastifyRequest, reply: FastifyReply, logic: () => Promise<any>) => {
    const key = req.headers["idempotency-key"] as string;
    if (!key) return await logic();

    const cached = db.readOne<{ status: number; body: string }>("select status, body from http_idempotency where key = ?", key);
    if (cached) return reply.code(cached.status).send(JSON.parse(cached.body));

    const result = await logic();
    db.write("insert into http_idempotency (key, status, body, created_at) values (?, ?, ?, ?)", key, reply.statusCode, JSON.stringify(result), deps.clock.now());
    return result;
  };

  const doCapture = async (orderId: string, ctx: Ctx, causationId?: string) => {
    const { amount: captureAmount, currency: opCurrency } = quoteForOrder(orderId, ctx.tenantId);

    return db.transaction(async () => {
      let charge = db.readOne<ChargeRow>(
        "select * from charges where order_id = ? order by created_at desc limit 1",
        orderId,
      );

      if (charge?.state === "captured" || charge?.state === "refunded") {
        return ok(toChargeResponse(charge));
      }

      if (!charge) {
        const authRes = await deps.clients.payments.authorize(
          { orderId, amount: captureAmount, currency: opCurrency, callbackUrl: `http://localhost:${deps.env.PORT ?? 3000}/callbacks/payments` },
          { tenantId: ctx.tenantId, correlationId: ctx.correlationId, idempotencyKey: orderId }
        );

        if (!authRes.ok) return authRes;

        charge = {
          charge_id: newId(),
          order_id: orderId,
          tenant_id: ctx.tenantId,
          payment_ref: authRes.value.paymentRef,
          state: authRes.value.state,
          amount: captureAmount,
          currency: opCurrency,
          created_at: deps.clock.now(),
        };

        db.write("insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", charge.charge_id, charge.order_id, charge.tenant_id, charge.payment_ref, charge.state, charge.amount, charge.currency, charge.created_at);
      }

      const capRes = await deps.clients.payments.capture(
        charge.payment_ref,
        captureAmount,
        { tenantId: ctx.tenantId, correlationId: ctx.correlationId, idempotencyKey: ctx.idempotencyKey ?? `capture-${orderId}` }
      );

      if (!capRes.ok) return capRes;

      const now = deps.clock.now();
      const captured: ChargeRow = {
        ...charge,
        charge_id: newId(),
        state: "captured",
        amount: captureAmount,
        created_at: now,
      };

      db.write("insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", captured.charge_id, captured.order_id, captured.tenant_id, captured.payment_ref, captured.state, captured.amount, captured.currency, captured.created_at);
      db.write("insert into ledger (id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)", newId(), captured.tenant_id, orderId, "capture", captureAmount, captured.currency, now, captured.payment_ref);
      
      outbox.enqueue(
        makeEnvelope({
          topic: "charge.captured",
          tenantId: captured.tenant_id,
          occurredAt: now,
          correlationId: ctx.correlationId,
          ...(causationId ? { causationId } : {}),
          payload: { orderId, chargeId: captured.payment_ref, amount: captureAmount, currency: captured.currency },
        })
      );

      return ok(toChargeResponse(captured));
    });
  };

  bindBillingService(deps, {
    async onOrderReturned(envelope: Envelope) {
      const payload = envelope.payload as { orderId: string };
      const res = await doCapture(payload.orderId, { tenantId: envelope.tenantId, correlationId: envelope.correlationId, idempotencyKey: `capture-${payload.orderId}` }, envelope.id);
      return res.ok ? ok(undefined) : res;
    },

    async onWashCompleted(envelope: Envelope) {
      const payload = envelope.payload as { orderId: string; cycleUnits: number };
      const existing = db.readOne<{ order_id: string }>(
        "select order_id from washes where order_id = ? order by created_at desc limit 1",
        payload.orderId,
      );

      if (!existing) {
        db.write(
          "insert into washes (order_id, cycle_units, created_at) values (?, ?, ?)",
          payload.orderId,
          payload.cycleUnits,
          deps.clock.now(),
        );
      }
      return ok(undefined);
    },

    async onOperatorUpdated(envelope: Envelope) {
      const payload = envelope.payload as { operatorId: string; pricingTier: string; region: string; currency: string; };
      const existing = db.readOne<{ operator_id: string }>(
        "select operator_id from operators where operator_id = ? order by created_at desc limit 1",
        payload.operatorId,
      );

      if (!existing) {
        db.write(
          "insert into operators (operator_id, pricing_tier, region, currency, created_at) values (?, ?, ?, ?, ?)",
          payload.operatorId,
          payload.pricingTier,
          payload.region,
          payload.currency,
          deps.clock.now(),
        );
      }
      return ok(undefined);
    },
  });

  for (const h of await registerHandlers(deps)) {
    app.sudsnik.registerStop(h.stop);
  }

  const quoteHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    const out = quoteForOrder(req.params.orderId, req.ctx.tenantId);
    return reply.send(out);
  };

  app.get(routes.quote.path, quoteHandler);
  app.get(`/v2${routes.quote.path}`, quoteHandler);

  const authorizeHandler = async (
    req: FastifyRequest<{ Body: { orderId: string; amount?: number; currency?: string; callbackUrl?: string } }>,
    reply: FastifyReply,
  ) => {
    return handleIdempotentRequest(req, reply, async () => {
      const orderId = req.body.orderId;
      const quote = quoteForOrder(orderId, req.ctx.tenantId);
      const amount = req.body.amount ?? quote.amount;
      const currency = req.body.currency ?? quote.currency;

      return db.transaction(async () => {
        const current = db.readOne<ChargeRow>("select * from charges where order_id = ? order by created_at desc limit 1", orderId);
        if (current && current.state !== "failed") {
          return reply.send(toChargeResponse(current));
        }

        const authRes = await deps.clients.payments.authorize(
          { orderId, amount, currency, callbackUrl: req.body.callbackUrl ?? `http://localhost:${deps.env.PORT ?? 3000}/callbacks/payments` },
          { ...req.ctx, idempotencyKey: orderId }
        );

        if (!authRes.ok) {
          const code = httpStatus(authRes.error.code);
          return reply.code(code === 500 ? 504 : code).send({ code: authRes.error.code, message: authRes.error.message, retryable: authRes.error.retryable });
        }

        const now = deps.clock.now();
        const row: ChargeRow = {
          charge_id: newId(),
          order_id: orderId,
          tenant_id: req.ctx.tenantId,
          payment_ref: authRes.value.paymentRef,
          state: authRes.value.state,
          amount,
          currency,
          created_at: now,
        };

        db.write("insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", row.charge_id, row.order_id, row.tenant_id, row.payment_ref, row.state, row.amount, row.currency, row.created_at);
        db.write("insert into ledger (id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)", newId(), req.ctx.tenantId, orderId, "authorize", amount, currency, now, authRes.value.paymentRef);

        return reply.send(toChargeResponse(row));
      });
    });
  };

  app.post(routes.authorize.path, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, authorizeHandler);
  app.post(`/v2${routes.authorize.path}`, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, authorizeHandler);

  const captureHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    return handleIdempotentRequest(req, reply, async () => {
      const orderId = req.params?.orderId;
      const res = await doCapture(orderId, req.ctx);

      if (!res.ok) {
        return reply.code(httpStatus(res.error.code)).send(res.error);
      }

      return reply.send(res.value);
    });
  };

  app.post(routes.capture.path, { schema: { headers: IdempotentHeaders } }, captureHandler);
  app.post(`/v2${routes.capture.path}`, { schema: { headers: IdempotentHeaders } }, captureHandler);

  const refundHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    return handleIdempotentRequest(req, reply, async () => {
      const orderId = req.params?.orderId;

      return db.transaction(async () => {
        let charge = db.readOne<ChargeRow>("select * from charges where order_id = ? order by created_at desc limit 1", orderId);

        if (!charge) {
          const quote = quoteForOrder(orderId, req.ctx.tenantId);
          charge = {
            charge_id: newId(),
            order_id: orderId,
            tenant_id: req.ctx.tenantId,
            payment_ref: newId(),
            state: "authorized",
            amount: quote.amount,
            currency: quote.currency,
            created_at: deps.clock.now(),
          };
        }

        if (charge.state === "refunded") {
          return reply.send(toChargeResponse(charge));
        }

        const refRes = await deps.clients.payments.refund(
          charge.payment_ref,
          charge.amount,
          { ...req.ctx, idempotencyKey: req.ctx.idempotencyKey ?? `refund-${orderId}` },
        );

        if (!refRes.ok) {
          const code = httpStatus(refRes.error.code);
          return reply.code(code === 500 ? 504 : code).send({ code: refRes.error.code, message: refRes.error.message, retryable: refRes.error.retryable });
        }

        const now = deps.clock.now();
        const refunded: ChargeRow = {
          ...charge,
          charge_id: newId(),
          state: "refunded",
          created_at: now,
        };

        db.write("insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", refunded.charge_id, refunded.order_id, refunded.tenant_id, refunded.payment_ref, refunded.state, refunded.amount, refunded.currency, refunded.created_at);
        db.write("insert into ledger (id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)", newId(), refunded.tenant_id, orderId, "refund", refunded.amount, refunded.currency, now, refunded.payment_ref);
        
        outbox.enqueue(
          makeEnvelope({
            topic: "refund.issued",
            tenantId: refunded.tenant_id,
            occurredAt: now,
            correlationId: req.ctx.correlationId,
            payload: { orderId, refundId: refunded.payment_ref, amount: refunded.amount, currency: refunded.currency },
          }),
        );

        return reply.send(toChargeResponse(refunded));
      });
    });
  };

  app.post(routes.refund.path, { schema: { headers: IdempotentHeaders } }, refundHandler);
  app.post(`/v2${routes.refund.path}`, { schema: { headers: IdempotentHeaders } }, refundHandler);

  const ledgerHandler = async (req: FastifyRequest<{ Querystring: { orderId?: string; limit?: string | number } }>, reply: FastifyReply) => {
    const limit = Number(req.query?.limit ?? 100);
    const orderId = req.query?.orderId;

    const rows = orderId
      ? db.read<LedgerRow>("select id, tenant_id, order_id, kind, amount, currency, at, ref from ledger where order_id = ? order by at asc limit ?", orderId, limit)
      : db.read<LedgerRow>("select id, tenant_id, order_id, kind, amount, currency, at, ref from ledger order by at asc limit ?", limit);

    const entries = rows.map((r) => ({
      entryId: r.id,
      tenantId: r.tenant_id,
      orderId: r.order_id,
      kind: r.kind,
      amount: r.amount,
      currency: r.currency,
      at: r.at,
      ...(r.ref ? { ref: r.ref } : {}),
    }));

    return reply.send(entries);
  };

  app.get(routes.ledger.path, { schema: { querystring: routes.ledger.query } }, ledgerHandler);
  app.get(`/v2${routes.ledger.path}`, { schema: { querystring: routes.ledger.query } }, ledgerHandler);

  const webhookHandler = async (
    req: FastifyRequest<{ Body: { id: string; paymentRef: string; orderId: string; event: "captured" | "refunded" | "failed"; amount: number; currency: string; atMs?: number; } }>,
    reply: FastifyReply,
  ) => {
    const ev = req.body;

    return db.transaction(() => {
      const dup = db.readOne<{ event_id: string }>("select event_id from webhook_dedupe where event_id = ? limit 1", ev.id);
      if (dup) return reply.send({ accepted: true, duplicate: true });

      const current = db.readOne<ChargeRow>(
        "select * from charges where payment_ref = ? order by created_at desc limit 1",
        ev.paymentRef,
      );

      const tenantId = current?.tenant_id || req.ctx?.tenantId;
      if (!tenantId) {
        req.log.error({ paymentRef: ev.paymentRef }, "Webhook received for untrackable tenant");
        return reply.code(400).send({ error: "Cannot resolve tenant context for webhook" });
      }

      db.write("insert into webhook_dedupe (event_id, received_at) values (?, ?)", ev.id, deps.clock.now());

      if (current?.state === ev.event) {
        return reply.send({ accepted: true, duplicate: false });
      }

      const now = ev.atMs ?? deps.clock.now();
      const amount = ev.amount ?? current?.amount ?? 0;
      
      const next: ChargeRow = {
        charge_id: newId(),
        order_id: ev.orderId,
        tenant_id: tenantId,
        payment_ref: ev.paymentRef,
        state: ev.event,
        amount,
        currency: ev.currency || current?.currency || DEFAULT_CURRENCY,
        created_at: now,
      };

      db.write("insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", next.charge_id, next.order_id, next.tenant_id, next.payment_ref, next.state, next.amount, next.currency, next.created_at);
      
      const ledgerKind = ev.event === "captured" ? "capture" : ev.event === "refunded" ? "refund" : "fee";
      db.write("insert into ledger (id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)", newId(), tenantId, ev.orderId, ledgerKind, amount, next.currency, now, ev.paymentRef);

      if (ev.event === "captured" || ev.event === "refunded") {
        outbox.enqueue(
          makeEnvelope({
            topic: ev.event === "captured" ? "charge.captured" : "refund.issued",
            tenantId,
            occurredAt: now,
            correlationId: req.ctx?.correlationId ?? newId(),
            payload: { orderId: ev.orderId, chargeId: ev.paymentRef, amount, currency: next.currency },
          }),
        );
      }

      return reply.send({ accepted: true, duplicate: false });
    });
  };

  app.post(routes.paymentsWebhook.path, { schema: { body: routes.paymentsWebhook.body } }, webhookHandler);
  app.post(`/v2${routes.paymentsWebhook.path}`, { schema: { body: routes.paymentsWebhook.body } }, webhookHandler);

  app.sudsnik.setReady(true);
  return app;
}

export async function start() {
  await bootService({ service, readEnv, createApp, handlersDir });
}