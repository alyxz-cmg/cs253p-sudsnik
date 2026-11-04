import { LINK_WINDOW_MINUTES, MINUTE_MS, ORBIT_MS, nextWindowStart, type Ctx, type EphemerisClient } from "@sudsnik/contracts";
import type { Window } from "@sudsnik/contracts/mocks/ephemeris";
import type { Cache } from "@sudsnik/infra-cache";
import { ok, type Result } from "@sudsnik/kernel";

export const LINK_WINDOW_MS = LINK_WINDOW_MINUTES * MINUTE_MS;

/** Where the next link window of a habitat comes from; variants differ in caching and in what happens when ephemeris fails. */
export interface WindowSource {
  next(habitatId: string, nowMs: number, ctx: Ctx): Promise<Result<Window>>;
}

/** The canon schedule, used when ephemeris cannot be asked. */
export function canonWindow(habitatId: string, nowMs: number): Window {
  const startMs = nextWindowStart(habitatId, nowMs);
  return { startMs, endMs: startMs + LINK_WINDOW_MS };
}

/** The first window starting at or after nowMs; a window already in progress is too late to launch into. */
export function firstWindowFrom(windows: readonly Window[], nowMs: number): Window | undefined {
  return windows.find((w) => w.startMs >= nowMs);
}

/** One provider call per tenant, habitat, and orbit; concurrent misses share the same in-flight answer. */
export function cachedWindows(
  cache: Cache<Window[]>,
  load: (habitatId: string, ctx: Ctx) => Promise<Result<Window[]>>,
): WindowSource {
  const pending = new Map<string, Promise<Result<Window[]>>>();
  return {
    async next(habitatId, nowMs, ctx) {
      const key = ctx.tenantId + ":" + habitatId + ":" + Math.floor(nowMs / ORBIT_MS);
      const hit = cache.get(key);
      if (hit) return ok(firstWindowFrom(hit, nowMs) ?? canonWindow(habitatId, nowMs));

      let request = pending.get(key);
      if (!request) {
        request = (async () => {
          const result = await load(habitatId, ctx);
          if (result.ok) cache.set(key, result.value, Math.max(1, ORBIT_MS - (nowMs % ORBIT_MS)));
          return result;
        })();
        pending.set(key, request);
      }
      try {
        const result = await request;
        if (!result.ok) return result;
        return ok(firstWindowFrom(result.value, nowMs) ?? canonWindow(habitatId, nowMs));
      } finally {
        if (pending.get(key) === request) pending.delete(key);
      }
    },
  };
}

/** One uncached provider lookup; retained for the naive comparison variant. */
export function liveWindows(client: EphemerisClient): WindowSource {
  return {
    async next(habitatId, nowMs, ctx) {
      const r = await client.windows(habitatId, ctx);
      if (!r.ok) return r;
      return ok(firstWindowFrom(r.value.windows, nowMs) ?? canonWindow(habitatId, nowMs));
    },
  };
}
