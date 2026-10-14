import { fileURLToPath } from "node:url";
import { bootService, readEnvWith } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { createBaseApp } from "@sudsnik/infra-http";
import { createOutbox, registerHandlers } from "@sudsnik/infra-queue";
import { BillingEnvSchema, type BillingService } from "@sudsnik/contracts/services/billing";
import type { ServiceDeps, Ctx } from "@sudsnik/contracts";
import { ok, err, sudsnikError } from "@sudsnik/kernel";
import { z } from "zod";

export const service = "billing" as const;
export const handlersDir = fileURLToPath(new URL("./handlers/", import.meta.url));
export const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

export function readEnv() {
  return readEnvWith(BillingEnvSchema);
}

export async function createApp(deps: ServiceDeps) {
  const app = await createBaseApp({ deps, version: "1.0.0", variant: "default", cost: () => ({ service, sinceMs: 0, totalUnits: 0, byOperation: {}, byEndpoint: {} }) });
  const db = openDb({ path: `${deps.dataDir}/${service}.sqlite`, service, meter: deps.meter, migrationsDir });
  app.sudsnik.registerStop(() => db.close());
  const outbox = createOutbox(db, deps.bus);
  outbox.start();
  app.sudsnik.registerStop(() => outbox.stop());

  for (const h of await registerHandlers(deps)) {
    app.sudsnik.registerStop(h.stop);
  }

  const IdempotentHeaders = z.object({ "idempotency-key": z.string() }).passthrough();

  app.get("/quotes/:orderId", async (req, reply) => {
    return reply.send({ orderId: (req.params as any).orderId, amount: 4900, currency: "USD" });
  });

  app.post("/charges/authorize", { schema: { headers: IdempotentHeaders } }, async (req, reply) => {
    return reply.send({ chargeId: "chg_1", state: "authorized", amount: 4900, currency: "USD" });
  });

  app.post("/charges/:orderId/capture", { schema: { headers: IdempotentHeaders } }, async (req, reply) => {
    return reply.send({ chargeId: "chg_1", state: "captured", amount: 4900, currency: "USD" });
  });

  app.post("/charges/:orderId/refund", { schema: { headers: IdempotentHeaders } }, async (req, reply) => {
    return reply.send({ refundId: "ref_1", amount: 4900, currency: "USD" });
  });

  app.get("/ledger", async (req, reply) => {
    return reply.send([]);
  });

  app.post("/callbacks/payments", async (req, reply) => {
    return reply.code(200).send({ ok: true });
  });

  app.sudsnik.setReady(true);
  return app;
}

export async function start() {
  await bootService({ service, readEnv, createApp, handlersDir });
}