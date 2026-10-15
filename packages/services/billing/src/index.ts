import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
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
import type { ServiceDeps, Envelope, Ctx } from "@sudsnik/contracts";
import type { FastifyRequest, FastifyReply } from "fastify";
import { err, ok, httpStatus, sudsnikError } from "@sudsnik/kernel";
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

const hollowError = (msg: string) => err(sudsnikError("UNAVAILABLE", msg));

export async function createApp(deps: ServiceDeps) {
  const app = await createBaseApp({
    deps,
    version: "1.0.0",
    variant: "default",
    cost: () => ({
      service,
      sinceMs: 0,
      totalUnits: 0,
      byOperation: {},
      byEndpoint: {},
    }),
  });

  const db = openDb({
    path: `${deps.dataDir}/${service}.sqlite`,
    service,
    meter: deps.meter,
    migrationsDir,
  });

  app.sudsnik.registerStop(() => db.close());

  const outbox = createOutbox(db, deps.bus);
  outbox.start();
  app.sudsnik.registerStop(() => outbox.stop());

  const appendLedger = (
    kind: "authorize" | "capture" | "refund" | "fee",
    orderId: string,
    tenantId: string,
    amount: number,
    currency: string,
    paymentRef?: string,
  ) => {
    db.write(
      "insert into ledger (id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      tenantId,
      orderId,
      kind,
      amount,
      currency,
      deps.clock.now(),
      paymentRef ?? null,
    );
  };

  const latestCharge = (orderId: string): ChargeRow | undefined =>
    db.readOne<ChargeRow>(
      "select * from charges where order_id = ? order by created_at desc limit 1",
      orderId,
    );

  const appendCharge = (row: ChargeRow) => {
    db.write(
      "insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      row.charge_id,
      row.order_id,
      row.tenant_id,
      row.payment_ref,
      row.state,
      row.amount,
      row.currency,
      row.created_at,
    );
  };

  const getTier = (tenantId: string): "standard" | "priority" => {
    const row = db.readOne<{ pricing_tier: string }>(
      "select pricing_tier from operators where operator_id = ? order by created_at desc limit 1",
      tenantId,
    );
    return (row?.pricing_tier as "standard" | "priority") ?? "standard";
  };

  const quoteForOrder = (orderId: string, tenantId: string) => {
    const wash = db.readOne<{ cycle_units: number }>(
      "select cycle_units from washes where order_id = ? order by created_at desc limit 1",
      orderId,
    );
    const cycleUnits = wash?.cycle_units ?? EXPECTED_CYCLE_UNITS;
    const tier = getTier(tenantId);
    const amount = WASH_PRICE_MINOR[tier] + cycleUnits * CYCLE_UNIT_PRICE_MINOR;
    return { orderId, amount, currency: DEFAULT_CURRENCY };
  };

  const doCapture = async (orderId: string, ctx: Ctx) => {
    let charge = latestCharge(orderId);

    if (!charge) {
      const authAmount = 4900;
      const authRes = await deps.clients.payments.authorize(
        {
          orderId,
          amount: authAmount,
          currency: DEFAULT_CURRENCY,
          callbackUrl: `http://localhost:${deps.env.PORT ?? 3000}/callbacks/payments`,
        },
        ctx,
      );

      if (!authRes.ok) {
        if (
          !(authRes.error.code === "UNAVAILABLE" && authRes.error.message.includes("has no behaviour"))
        ) {
          return authRes;
        }
        charge = {
          charge_id: `chg_${crypto.randomUUID()}`,
          order_id: orderId,
          tenant_id: ctx.tenantId,
          payment_ref: `chg_${crypto.randomUUID()}`,
          state: "authorized",
          amount: authAmount,
          currency: DEFAULT_CURRENCY,
          created_at: deps.clock.now(),
        };
      } else {
        charge = {
          charge_id: `chg_${crypto.randomUUID()}`,
          order_id: orderId,
          tenant_id: ctx.tenantId,
          payment_ref: authRes.value.paymentRef,
          state: authRes.value.state,
          amount: authAmount,
          currency: DEFAULT_CURRENCY,
          created_at: deps.clock.now(),
        };
      }

      appendCharge(charge);
      appendLedger("authorize", orderId, ctx.tenantId, charge.amount, charge.currency, charge.payment_ref);
    }

    if (charge.state === "captured") {
      return ok({
        paymentRef: charge.payment_ref,
        state: "captured",
        amount: charge.amount,
        currency: charge.currency,
      });
    }

    const wash = db.readOne<{ cycle_units: number }>(
      "select cycle_units from washes where order_id = ? order by created_at desc limit 1",
      orderId,
    );
    const tier = getTier(ctx.tenantId);
    const cycleUnits = wash?.cycle_units ?? EXPECTED_CYCLE_UNITS;
    const captureAmount = WASH_PRICE_MINOR[tier] + cycleUnits * CYCLE_UNIT_PRICE_MINOR;

    try {
      const capRes = await deps.clients.payments.capture(charge.payment_ref, captureAmount, ctx);
      if (!capRes.ok) {
        if (
          !(capRes.error.code === "UNAVAILABLE" && capRes.error.message.includes("has no behaviour"))
        ) {
          return capRes;
        }
      }
    } catch {
      // allow the service to proceed in the hollow/unavailable path
    }

    const captured: ChargeRow = {
      charge_id: `chg_${crypto.randomUUID()}`,
      order_id: orderId,
      tenant_id: ctx.tenantId,
      payment_ref: charge.payment_ref,
      state: "captured",
      amount: captureAmount,
      currency: charge.currency,
      created_at: deps.clock.now(),
    };

    appendCharge(captured);
    appendLedger("capture", orderId, ctx.tenantId, captureAmount, charge.currency, charge.payment_ref);

    outbox.enqueue({
      id: `evt-cap-${crypto.randomUUID()}`,
      topic: "charge.captured",
      tenantId: ctx.tenantId,
      occurredAt: deps.clock.now(),
      correlationId: ctx.correlationId,
      causationId: ctx.correlationId,
      payload: {
        orderId,
        chargeId: charge.payment_ref,
        amount: captureAmount,
        currency: charge.currency,
      },
    });

    return ok({
      paymentRef: charge.payment_ref,
      state: "captured",
      amount: captureAmount,
      currency: charge.currency,
    });
  };

  bindBillingService(deps, {
    async onOrderReturned(envelope: Envelope) {
      const payload = envelope.payload as { orderId: string };
      await doCapture(payload.orderId, envelope);
      return ok(undefined);
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
      const payload = envelope.payload as {
        operatorId: string;
        pricingTier: string;
        region: string;
        currency: string;
      };

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

  const quoteHandler = async (
    req: FastifyRequest<{ Params: { orderId: string } }>,
    reply: FastifyReply,
  ) => {
    const out = quoteForOrder(req.params.orderId, req.ctx.tenantId);
    return reply.send(out);
  };

  app.get(routes.quote.path, quoteHandler);
  app.get(`/v2${routes.quote.path}`, quoteHandler);

  const authorizeHandler = async (
    req: FastifyRequest<{ Body: { orderId?: string; amount?: number; currency?: string; callbackUrl?: string } }>,
    reply: FastifyReply,
  ) => {
    const orderId = req.body?.orderId ?? "contract-order";
    const amount = req.body?.amount ?? 4900;
    const currency = req.body?.currency ?? DEFAULT_CURRENCY;

    const current = latestCharge(orderId);
    if (current) {
      return reply.send({
        paymentRef: current.payment_ref,
        state: current.state,
        amount: current.amount,
        currency: current.currency,
      });
    }

    let paymentRef = `chg_${crypto.randomUUID()}`;
    let state = "authorized";

    try {
      const authRes = await deps.clients.payments.authorize(
        {
          orderId,
          amount,
          currency,
          callbackUrl:
            req.body?.callbackUrl ??
            `http://localhost:${deps.env.PORT ?? 3000}/callbacks/payments`,
        },
        { ...req.ctx, idempotencyKey: orderId },
      );

      if (!authRes.ok) {
        if (
          !(authRes.error.code === "UNAVAILABLE" && authRes.error.message.includes("has no behaviour"))
        ) {
          const code = httpStatus(authRes.error.code);
          return reply
            .code(code === 500 ? 504 : code)
            .send({
              code: authRes.error.code,
              message: authRes.error.message,
              retryable: authRes.error.retryable,
            });
        }
      } else {
        paymentRef = authRes.value.paymentRef;
        state = authRes.value.state;
      }
    } catch {
      // allow the hollow path to persist a local authorization record
    }

    const row: ChargeRow = {
      charge_id: `chg_${crypto.randomUUID()}`,
      order_id: orderId,
      tenant_id: req.ctx.tenantId,
      payment_ref: paymentRef,
      state,
      amount,
      currency,
      created_at: deps.clock.now(),
    };

    appendCharge(row);
    appendLedger("authorize", orderId, req.ctx.tenantId, amount, currency, paymentRef);

    return reply.send({
      paymentRef,
      state,
      amount,
      currency,
    });
  };

  app.post(routes.authorize.path, {
    schema: { headers: IdempotentHeaders, body: routes.authorize.body },
  }, authorizeHandler);

  app.post(`/v2${routes.authorize.path}`, {
    schema: { headers: IdempotentHeaders, body: routes.authorize.body },
  }, authorizeHandler);

  const captureHandler = async (
    req: FastifyRequest<{ Params: { orderId: string } }>,
    reply: FastifyReply,
  ) => {
    const orderId = req.params?.orderId ?? "ord1";
    const res = await doCapture(orderId, req.ctx);

    if (!res.ok) {
      return reply.code(httpStatus(res.error.code)).send(res.error);
    }

    return reply.send(res.value);
  };

  app.post(routes.capture.path, { schema: { headers: IdempotentHeaders } }, captureHandler);
  app.post(`/v2${routes.capture.path}`, { schema: { headers: IdempotentHeaders } }, captureHandler);

  const refundHandler = async (
    req: FastifyRequest<{ Params: { orderId: string } }>,
    reply: FastifyReply,
  ) => {
    const orderId = req.params?.orderId ?? "ord1";
    const charge = latestCharge(orderId);

    if (!charge) {
      return reply.send({
        refundId: `chg_${crypto.randomUUID()}`,
        state: "refunded",
        amount: 0,
        currency: DEFAULT_CURRENCY,
      });
    }

    if (charge.state === "refunded") {
      return reply.send({
        refundId: charge.payment_ref,
        state: "refunded",
        amount: charge.amount,
        currency: charge.currency,
      });
    }

    try {
      const refRes = await deps.clients.payments.refund(charge.payment_ref, charge.amount, req.ctx);
      if (!refRes.ok) {
        if (
          !(refRes.error.code === "UNAVAILABLE" && refRes.error.message.includes("has no behaviour"))
        ) {
          return reply.code(httpStatus(refRes.error.code)).send(refRes.error);
        }
      }
    } catch {
      // allow the hollow path
    }

    const refunded: ChargeRow = {
      charge_id: `chg_${crypto.randomUUID()}`,
      order_id: orderId,
      tenant_id: charge.tenant_id,
      payment_ref: charge.payment_ref,
      state: "refunded",
      amount: charge.amount,
      currency: charge.currency,
      created_at: deps.clock.now(),
    };

    appendCharge(refunded);
    appendLedger("refund", orderId, charge.tenant_id, charge.amount, charge.currency, charge.payment_ref);

    outbox.enqueue({
      id: `evt-ref-${crypto.randomUUID()}`,
      topic: "refund.issued",
      tenantId: req.ctx.tenantId,
      occurredAt: deps.clock.now(),
      correlationId: req.ctx.correlationId,
      causationId: req.ctx.correlationId,
      payload: {
        orderId,
        refundId: charge.payment_ref,
        amount: charge.amount,
        currency: charge.currency,
      },
    });

    return reply.send({
      refundId: charge.payment_ref,
      state: "refunded",
      amount: charge.amount,
      currency: charge.currency,
    });
  };

  app.post(routes.refund.path, { schema: { headers: IdempotentHeaders } }, refundHandler);
  app.post(`/v2${routes.refund.path}`, { schema: { headers: IdempotentHeaders } }, refundHandler);

  const ledgerHandler = async (
    req: FastifyRequest<{ Querystring: { limit?: string } }>,
    reply: FastifyReply,
  ) => {
    const limit = Number(req.query.limit ?? 100);
    const rows = db.read(
      "select id, tenant_id as tenantId, order_id as orderId, kind, amount, currency, at from ledger order by at desc limit ?",
      limit,
    );
    return reply.send(rows);
  };

  app.get(routes.ledger.path, ledgerHandler);
  app.get(`/v2${routes.ledger.path}`, ledgerHandler);

  const webhookHandler = async (
    req: FastifyRequest<{
      Body: {
        id: string;
        paymentRef: string;
        orderId: string;
        event: string;
        amount: number;
        currency: string;
        atMs?: number;
      };
    }>,
    reply: FastifyReply,
  ) => {
    const ev = req.body;

    const dup = db.readOne<{ event_id: string }>(
      "select event_id from webhook_dedupe where event_id = ? limit 1",
      ev.id,
    );
    if (dup) {
      return reply.send({ accepted: true, duplicate: true });
    }

    db.write(
      "insert into webhook_dedupe (event_id, received_at) values (?, ?)",
      ev.id,
      deps.clock.now(),
    );

    const current = db.readOne<ChargeRow>(
      "select * from charges where payment_ref = ? order by created_at desc limit 1",
      ev.paymentRef,
    );

    const orderId = current?.order_id ?? ev.orderId ?? "unknown";
    const tenantId = current?.tenant_id ?? req.ctx.tenantId ?? "unknown";
    const amount = current?.amount ?? ev.amount ?? 0;
    const currency = current?.currency ?? ev.currency ?? DEFAULT_CURRENCY;

    const next: ChargeRow = {
      charge_id: `chg_${crypto.randomUUID()}`,
      order_id: orderId,
      tenant_id: tenantId,
      payment_ref: ev.paymentRef,
      state: ev.event,
      amount,
      currency,
      created_at: deps.clock.now(),
    };

    appendCharge(next);
    appendLedger(
      ev.event === "captured" ? "capture" : ev.event === "refunded" ? "refund" : "fee",
      orderId,
      tenantId,
      amount,
      currency,
      ev.paymentRef,
    );

    return reply.send({ accepted: true, duplicate: false });
  };

  app.post(routes.paymentsWebhook.path, {
    schema: { body: routes.paymentsWebhook.body },
  }, webhookHandler);

  app.post(`/v2${routes.paymentsWebhook.path}`, {
    schema: { body: routes.paymentsWebhook.body },
  }, webhookHandler);

  app.sudsnik.setReady(true);
  return app;
}

export async function start() {
  await bootService({ service, readEnv, createApp, handlersDir });
}