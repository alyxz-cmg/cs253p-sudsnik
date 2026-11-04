import { fileURLToPath } from "node:url";
import { ORBIT_MS, type Ctx, type ServiceDeps } from "@sudsnik/contracts";
import type { NodeStatusResponse, Window } from "@sudsnik/contracts/mocks/ephemeris";
import { createCache } from "@sudsnik/infra-cache";
import { createBreaker, type Breaker } from "@sudsnik/infra-resilience";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { buildApp } from "../../app.js";
import { roundRobinRanker, statusRanker } from "../../holds.js";
import type { Store } from "../../store.js";
import type { Strategy } from "../../strategy.js";
import { cachedWindows, canonWindow } from "../../windows.js";
import { naiveTrust } from "../naive/trust.js";

export const variant = "optimized";
export const handlersDir = fileURLToPath(new URL("../../handlers/", import.meta.url));
export const STATUS_TTL_MS = 60_000;

/**
 * Bounded, tenant-scoped provider reads. Window schedules are stable for an orbit; node status is kept
 * only for the remainder of the provider's own 60-second cache lifetime. Requests for the same key coalesce.
 */
export function optimizedStrategy(deps: ServiceDeps, store: Store): Strategy {
  const ephemeris = deps.clients.ephemeris;
  const windowCache = createCache<Window[]>({ max: 512, ttlMs: ORBIT_MS, clock: deps.clock, meter: deps.meter, service: deps.service });
  const statusCache = createCache<NodeStatusResponse>({ max: 256, ttlMs: STATUS_TTL_MS, clock: deps.clock, meter: deps.meter, service: deps.service });
  const lastStatus = new Map<string, NodeStatusResponse>();
  const pendingStatus = new Map<string, Promise<Result<NodeStatusResponse>>>();
  const breakers = new Map<string, Breaker>();
  const openedAt = new Map<string, number>();

  function breakerFor(ctx: Ctx): Breaker {
    let breaker = breakers.get(ctx.tenantId);
    if (!breaker) {
      breaker = createBreaker({
        name: "ephemeris",
        failureThreshold: 1,
        openMs: ORBIT_MS,
        clock: deps.clock,
        onStateChange: (_from, to) => {
          if (to === "open") openedAt.set(ctx.tenantId, deps.clock.now());
          else openedAt.delete(ctx.tenantId);
          deps.telemetry.logger.warn("breaker_state", { name: "ephemeris", tenantId: ctx.tenantId, from: _from, to });
        },
      });
      breakers.set(ctx.tenantId, breaker);
    }
    return breaker;
  }

  /** Let createBreaker make its half-open transition after one simulated orbit. */
  function breakerIsCoolingDown(ctx: Ctx): boolean {
    const breaker = breakerFor(ctx);
    const opened = openedAt.get(ctx.tenantId);
    return breaker.state() === "open" && opened !== undefined && deps.clock.now() - opened < ORBIT_MS;
  }

  async function statusFor(nodeId: string, ctx: Ctx): Promise<Result<NodeStatusResponse>> {
    const key = ctx.tenantId + ":" + nodeId;
    const hit = statusCache.get(key);
    if (hit) return ok(hit);

    const stale = lastStatus.get(key);
    const breaker = breakerFor(ctx);
    if (breakerIsCoolingDown(ctx)) {
      return stale ? ok(stale) : err(sudsnikError("UNAVAILABLE", "ephemeris breaker is open"));
    }

    let request = pendingStatus.get(key);
    if (!request) {
      request = (async () => {
        try {
          const result = await breaker.exec(() => ephemeris.status(nodeId, ctx));
          if (result.ok) {
            lastStatus.set(key, result.value);
            const age = Math.max(0, deps.clock.now() - result.value.cachedAtMs);
            statusCache.set(key, result.value, Math.max(1, STATUS_TTL_MS - age));
          }
          return result;
        } catch (cause) {
          return err(sudsnikError("UNAVAILABLE", "ephemeris status request threw", cause));
        }
      })();
      pendingStatus.set(key, request);
    }

    try {
      const result = await request;
      if (!result.ok && result.error.retryable && stale) return ok(stale);
      return result;
    } finally {
      if (pendingStatus.get(key) === request) pendingStatus.delete(key);
    }
  }

  const windows = cachedWindows(windowCache, async (habitatId, ctx) => {
    const breaker = breakerFor(ctx);
    if (breakerIsCoolingDown(ctx)) return ok([canonWindow(habitatId, deps.clock.now())]);
    const result = await breaker.exec(() => ephemeris.windows(habitatId, ctx));
    if (result.ok) return ok(result.value.windows);
    return result.error.retryable ? ok([canonWindow(habitatId, deps.clock.now())]) : err(result.error);
  });

  const liveNodes = statusRanker(statusFor);
  const fallbackNodes = roundRobinRanker(store);

  return {
    queueForever: true,
    windows,
    nodes: {
      async rank(ctx) {
        if (breakerIsCoolingDown(ctx)) return fallbackNodes.rank(ctx);
        const result = await liveNodes.rank(ctx);
        return result.ok ? result : fallbackNodes.rank(ctx);
      },
    },
    async inContact(nodeId, ctx) {
      const stale = lastStatus.get(ctx.tenantId + ":" + nodeId);
      const result = await statusFor(nodeId, ctx);
      if (result.ok) return ok(result.value.inContact);
      return result.error.retryable ? ok(stale?.inContact ?? false) : result;
    },
    ingest: naiveTrust,
  };
}

export function createApp(deps: ServiceDeps) {
  return buildApp(deps, variant, optimizedStrategy);
}
