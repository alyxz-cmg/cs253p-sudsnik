import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { sudsnikError } from "@sudsnik/kernel";
import { z } from "zod";

export function readEnv() {
  return {};
}

export async function createApp(env: any = {}) {
  const server = Fastify();
  
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  const hollowErrorPayload = sudsnikError("UNAVAILABLE", "billing is hollow");
  const IdempotentHeaders = z.object({ "idempotency-key": z.string() }).passthrough();

  server.get("/health", async (request, reply) => reply.status(200).send("OK"));
  server.get("/ready", async (request, reply) => reply.status(200).send({ ready: true, service: "billing" }));
  server.get("/version", async (request, reply) => reply.status(200).send({ service: "billing", variant: "hollow" }));

  server.get("/quotes/:orderId", async (request, reply) => reply.status(501).send(hollowErrorPayload));
  
  server.post("/charges/authorize", { schema: { headers: IdempotentHeaders } }, async (request, reply) => reply.status(501).send(hollowErrorPayload));
  server.post("/charges/:orderId/capture", { schema: { headers: IdempotentHeaders } }, async (request, reply) => reply.status(501).send(hollowErrorPayload));
  server.post("/charges/:orderId/refund", { schema: { headers: IdempotentHeaders } }, async (request, reply) => reply.status(501).send(hollowErrorPayload));
  
  server.get("/ledger", async (request, reply) => reply.status(501).send(hollowErrorPayload));
  server.post("/callbacks/payments", async (request, reply) => reply.status(501).send(hollowErrorPayload));

  return server;
}