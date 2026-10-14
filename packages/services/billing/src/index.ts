import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { z } from "zod";
import { routes } from "@sudsnik/contracts/services/billing";
import { join } from "path";

export const handlersDir = join(import.meta.dirname, "topics");

export function readEnv() {
  return {
    PORT: process.env.PORT ? Number(process.env.PORT) : 4004,
  };
}

export async function createApp(env: any = {}) {
  const server = Fastify();
  
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  server.get("/health", async () => "OK");
  server.get("/ready", async () => ({ ready: true, service: "billing" }));
  server.get("/cost", async () => ({}));
  server.get("/version", async () => ({ service: "billing", variant: "default" }));

  server.addHook("preHandler", async (request, reply) => {
    const url = request.routeOptions.url;
    const isLifecycle = url ? ["/health", "/ready", "/version", "/cost"].includes(url) : false;
    
    if (!isLifecycle && !request.headers["x-sudsnik-tenant"]) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Missing tenant" } });
    }
  });

  const IdempotentHeaders = z.object({ "idempotency-key": z.string() }).passthrough();

  server.get(routes.quote.path, async (request, reply) => {
    return reply.status(501).send(); 
  });

  server.post(routes.authorize.path, { schema: { body: routes.authorize.body, headers: IdempotentHeaders } }, async (request, reply) => {
    return reply.status(501).send();
  });

  server.post(routes.capture.path, { schema: { headers: IdempotentHeaders } }, async (request, reply) => {
    return reply.status(501).send();
  });

  server.post(routes.refund.path, { schema: { headers: IdempotentHeaders } }, async (request, reply) => {
    return reply.status(501).send();
  });

  server.get(routes.ledger.path, { schema: { querystring: routes.ledger.query } }, async (request, reply) => {
    return reply.status(501).send();
  });

  server.post(routes.paymentsWebhook.path, { schema: { body: routes.paymentsWebhook.body } }, async (request, reply) => {
    return reply.status(501).send();
  });

  (server as any).drain = async () => {};

  return server;
}

let activeServer: any;

export async function start(env: any = {}) {
  activeServer = await createApp(env);
  const port = env.PORT || 4004;
  
  await activeServer.listen({ port, host: "0.0.0.0" });
  console.log(`Billing service (canary) listening on port ${port}`);
  return activeServer;
}

export async function stop() {
  if (activeServer) {
    if (typeof activeServer.drain === 'function') {
      await activeServer.drain();
    }
    await activeServer.close();
  }
}