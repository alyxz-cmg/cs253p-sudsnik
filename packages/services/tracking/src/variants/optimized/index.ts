import { SHUTTLES, type Ctx, type ServiceDeps } from "@sudsnik/contracts";
import type { Position } from "@sudsnik/contracts/services/tracking";
import { ok, type Result } from "@sudsnik/kernel";
import { buildApp, cached, fresh, ingest, podLocation, type Parts } from "../../app.js";

export const variant = "optimized";

function service(parts: Parts) {
  const { deps, store, ttlMs } = parts;
  const pending = new Map<string, Promise<Result<Position>>>();

  async function position(shuttleId: string, ctx: Ctx): Promise<Result<Position>> {
    const key = ctx.tenantId + ":" + shuttleId;
    let request = pending.get(key);
    if (!request) {
      request = (async () => {
        const result = await deps.clients.ephemeris.position(shuttleId, ctx);
        if (!result.ok) return result;
        store.putPosition({ shuttleId, orbitPhase: result.value.orbitPhase, observedAt: result.value.atMs });
        return ok(fresh(result.value));
      })();
      pending.set(key, request);
    }
    try {
      return await request;
    } finally {
      if (pending.get(key) === request) pending.delete(key);
    }
  }

  async function positionCached(shuttleId: string, ctx: Ctx): Promise<Result<Position>> {
    const known = store.position(shuttleId);
    if (known && deps.clock.now() - known.observedAt <= ttlMs) return ok(cached(known));
    return position(shuttleId, ctx);
  }

  return {
    position,
    positionCached,
    async positions(ctx: Ctx): Promise<Result<Position[]>> {
      const results = await Promise.all(SHUTTLES.map((shuttleId) => position(shuttleId, ctx)));
      const positions: Position[] = [];
      for (const result of results) {
        if (!result.ok) return result;
        positions.push(result.value);
      }
      return ok(positions);
    },
    podLocation: podLocation(parts),
    relay: (body: Parameters<typeof ingest>[1], ctx: Ctx) => ingest(parts, body, ctx),
  };
}

export function createApp(deps: ServiceDeps) {
  return buildApp(deps, "optimized", service);
}
