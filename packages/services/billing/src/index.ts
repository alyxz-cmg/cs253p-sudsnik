import { fileURLToPath } from "node:url";
import { bootService, readEnvWith } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { createBaseApp } from "@sudsnik/infra-http";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { BillingEnvSchema } from "@sudsnik/contracts/services/billing";
import { routes } from "@sudsnik/contracts/services/billing";
import type { ServiceDeps } from "@sudsnik/contracts";
import { ok } from "@sudsnik/kernel";
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
    async onOrderReturned() {
      return ok(undefined);
    },
    async onWashCompleted() {
      return ok(undefined);
    },
    async onOperatorUpdated() {
      return ok(undefined);
    },
  });

  for (const h of await registerHandlers(deps)) {
    app.sudsnik.registerStop(h.stop);
  }

  app.get(routes.quote.path, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    return reply.send({ orderId, amount: 4900, currency: "USD" });
  });

  app.post(routes.authorize.path, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, async (req, reply) => {
    return reply.send({ chargeId: "chg_1", state: "authorized", amount: 4900, currency: "USD" });
  });

  app.post(routes.capture.path, { schema: { headers: IdempotentHeaders } }, async (req, reply) => {
    return reply.send({ chargeId: "chg_1", state: "captured", amount: 4900, currency: "USD" });
  });

  app.post(routes.refund.path, { schema: { headers: IdempotentHeaders } }, async (req, reply) => {
    return reply.send({ refundId: "ref_1", amount: 4900, currency: "USD" });
  });

  app.get(routes.ledger.path, async (req, reply) => {
    return reply.send([]);
  });

  app.post(routes.paymentsWebhook.path, { schema: { body: routes.paymentsWebhook.body } }, async (req, reply) => {
    return reply.code(200).send({ ok: true });
  });

  app.sudsnik.setReady(true);
  return app;
}

export async function start() {
  await bootService({ service, readEnv, createApp, handlersDir });
}