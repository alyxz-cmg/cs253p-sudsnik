import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { z } from "zod";

export function readEnv() {
  return {};
}

export async function createApp(env: any = {}) {
  const server = Fastify();
  
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  const IdempotentHeaders = z.object({ "idempotency-key": z.string() }).passthrough();

  server.get("/health", async (request, reply) => reply.status(200).send("OK"));
  server.get("/ready", async (request, reply) => reply.status(200).send({ ready: true, service: "billing" }));
  server.get("/version", async (request, reply) => reply.status(200).send({ service: "billing", variant: "default" }));

  server.get("/quotes/:orderId", async (request, reply) => reply.status(501).send());
  server.post("/charges/authorize", { schema: { headers: IdempotentHeaders } }, async (request, reply) => reply.status(501).send());
  server.post("/charges/:orderId/capture", { schema: { headers: IdempotentHeaders } }, async (request, reply) => reply.status(501).send());
  server.post("/charges/:orderId/refund", { schema: { headers: IdempotentHeaders } }, async (request, reply) => reply.status(501).send());
  server.get("/ledger", async (request, reply) => reply.status(501).send());
  server.post("/callbacks/payments", async (request, reply) => reply.status(501).send());

  return server;
}