import { fileURLToPath } from "node:url";
import { bootService, readEnvWith } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { createBaseApp } from "@sudsnik/infra-http";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { BillingEnvSchema } from "@sudsnik/contracts/services/billing";
import { routes } from "@sudsnik/contracts/services/billing";
import type { ServiceDeps } from "@sudsnik/contracts";
import type { FastifyRequest, FastifyReply } from "fastify";
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

  const quoteHandler = async (req: FastifyRequest<{ Params: { orderId: string } }>, reply: FastifyReply) => {
    return reply.send({ orderId: req.params.orderId, amount: 4900, currency: "USD" });
  };
  app.get(routes.quote.path, quoteHandler);
  app.get(`/v2${routes.quote.path}`, quoteHandler);

  const authorizeHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ chargeId: "chg_1", state: "authorized", amount: 4900, currency: "USD" });
  };
  app.post(routes.authorize.path, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, authorizeHandler);
  app.post(`/v2${routes.authorize.path}`, { schema: { headers: IdempotentHeaders, body: routes.authorize.body } }, authorizeHandler);

  const captureHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ chargeId: "chg_1", state: "captured", amount: 4900, currency: "USD" });
  };
  app.post(routes.capture.path, { schema: { headers: IdempotentHeaders } }, captureHandler);
  app.post(`/v2${routes.capture.path}`, { schema: { headers: IdempotentHeaders } }, captureHandler);

  const refundHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ refundId: "ref_1", amount: 4900, currency: "USD" });
  };
  app.post(routes.refund.path, { schema: { headers: IdempotentHeaders } }, refundHandler);
  app.post(`/v2${routes.refund.path}`, { schema: { headers: IdempotentHeaders } }, refundHandler);

  const ledgerHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send([]);
  };
  app.get(routes.ledger.path, ledgerHandler);
  app.get(`/v2${routes.ledger.path}`, ledgerHandler);

  const webhookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ accepted: true, duplicate: false });
  };
  app.post(routes.paymentsWebhook.path, { schema: { body: routes.paymentsWebhook.body } }, webhookHandler);
  app.post(`/v2${routes.paymentsWebhook.path}`, { schema: { body: routes.paymentsWebhook.body } }, webhookHandler);

  app.sudsnik.setReady(true);
  return app;
}

export async function start() {
  await bootService({ service, readEnv, createApp, handlersDir });
}