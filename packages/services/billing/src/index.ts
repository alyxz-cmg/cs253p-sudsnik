import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { sudsnikError } from "@sudsnik/kernel";
import { z } from "zod";

const server = Fastify();

server.setValidatorCompiler(validatorCompiler);
server.setSerializerCompiler(serializerCompiler);

const hollowErrorPayload = sudsnikError("UNAVAILABLE", "billing is hollow");

const IdempotentHeaders = z.object({
  "idempotency-key": z.string(),
}).passthrough();

server.get("/health", async (request, reply) => {
  return reply.status(200).send("OK");
});

server.get("/ready", async (request, reply) => {
  return reply.status(200).send({ ready: true, service: "billing" });
});

server.get("/version", async (request, reply) => {
  return reply.status(200).send({ service: "billing", variant: "hollow" });
});

server.get("/quotes/:orderId", async (request, reply) => {
  return reply.status(501).send(hollowErrorPayload);
});

// Adding the schema to the write routes
server.post("/charges/authorize", {
  schema: { headers: IdempotentHeaders }
}, async (request, reply) => {
  return reply.status(501).send(hollowErrorPayload);
});

server.post("/charges/:orderId/capture", {
  schema: { headers: IdempotentHeaders }
}, async (request, reply) => {
  return reply.status(501).send(hollowErrorPayload);
});

server.post("/charges/:orderId/refund", {
  schema: { headers: IdempotentHeaders }
}, async (request, reply) => {
  return reply.status(501).send(hollowErrorPayload);
});

server.get("/ledger", async (request, reply) => {
  return reply.status(501).send(hollowErrorPayload);
});

server.post("/callbacks/payments", async (request, reply) => {
  return reply.status(501).send(hollowErrorPayload);
});

const start = async () => {
  try {
    await server.listen({ port: 4004, host: "0.0.0.0" });
    console.log("Billing service (hollow) listening on port 4004");
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();