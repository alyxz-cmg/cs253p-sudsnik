
import {
  type Ctx,
  type ServiceDeps,
} from "@sudsnik/contracts";
import type { Position } from "@sudsnik/contracts/services/tracking";
import {
  err,
  ok,
  sudsnikError,
  type Result,
} from "@sudsnik/kernel";
import {
  buildApp,
  cached,
  fresh,
  ingest,
  podLocation,
  type Parts,
} from "../../app.js";
import type { StoredPosition } from "../../store.js";

export const variant = "optimized";

interface CacheEntry {
  position: StoredPosition;
  expiresAt: number;
}

function service(parts: Parts) {
  const { deps, store, ttlMs } = parts;

  // In-memory cache, backed by the persistent SQLite store.
  const cache = new Map<string, CacheEntry>();

  // Coalesce concurrent fresh ephemeris requests.
  const pending = new Map<
    string,
    Promise<Result<Position>>
  >();

  function keyOf(shuttleId: string, ctx: Ctx): string {
    return `${ctx.tenantId}:${shuttleId}`;
  }

  function remember(
  ctx: Ctx,
  position: StoredPosition,
): void {
  const key = keyOf(position.shuttleId, ctx);
  const previous = cache.get(key);

  // Never let an out-of-order callback replace a newer observation.
  if (
    previous &&
    previous.position.observedAt > position.observedAt
  ) {
    return;
  }

  cache.set(key, {
    position,
    expiresAt: deps.clock.now() + ttlMs,
  });
}

  // Fresh read: calls ephemeris and persists the observation.
  async function position(
    shuttleId: string,
    ctx: Ctx,
  ): Promise<Result<Position>> {
    const key = keyOf(shuttleId, ctx);

    let request = pending.get(key);

    if (!request) {
      request = (async () => {
        const result = await deps.clients.ephemeris.position(
          shuttleId,
          ctx,
        );

        if (!result.ok) return result;

        const observed: StoredPosition = {
          shuttleId,
          orbitPhase: result.value.orbitPhase,
          observedAt: result.value.atMs,
        };

        store.putPosition(observed);

        // If the provider returned an older observation, retain
        // the newer position already stored in SQLite.
        const latest = store.position(shuttleId) ?? observed;

        remember(ctx, latest);

        return ok(fresh(result.value));
      })();

      pending.set(key, request);
    }

    try {
      return await request;
    } finally {
      if (pending.get(key) === request) {
        pending.delete(key);
      }
    }
  }

  // Cached read: memory first, persistent store second.
  // This function intentionally never calls ephemeris.
  async function positionCached(
  shuttleId: string,
  ctx: Ctx,
): Promise<Result<Position>> {
  const key = keyOf(shuttleId, ctx);
  const now = deps.clock.now();

  // SQLite is authoritative. Check it before returning an
  // in-memory entry so a newer callback cannot be hidden.
  const stored = store.position(shuttleId);

  if (!stored) {
    cache.delete(key);
    return err(
      sudsnikError(
        "NOT_FOUND",
        `no stored position for shuttle ${shuttleId}`,
      ),
    );
  }

  const hit = cache.get(key);

  // Select the newest observation.
  const latest =
    hit && hit.position.observedAt > stored.observedAt
      ? hit.position
      : stored;

  // An expired observation must be refreshed from ephemeris.
  // An expired memory entry alone does not require a provider call.
  if (now - latest.observedAt > ttlMs) {
    cache.delete(key);
    return position(shuttleId, ctx);
  }

  // Rehydrate the memory cache after expiration or when SQLite
  // contains a newer observation.
  if (
    !hit ||
    hit.expiresAt <= now ||
    latest.observedAt > hit.position.observedAt
  ) {
    remember(ctx, latest);
  }

  return ok(cached(latest));
}

  return {
    position,
    positionCached,

    // Only return shuttles with a position actually stored.
    async positions(ctx: Ctx): Promise<Result<Position[]>> {
      const stored = store.positions();

      for (const position of stored) {
        remember(ctx, position);
      }

      return ok(stored.map(cached));
    },

    podLocation: podLocation(parts),

    // Accepted callbacks update the persistent store and refresh
    // the in-memory cache. Rejected callbacks do not populate it.
    relay: (
      body: Parameters<typeof ingest>[1],
      ctx: Ctx,
    ) =>
      ingest(parts, body, ctx, (position) => {
        remember(ctx, position);
      }),
  };
}

export function createApp(deps: ServiceDeps) {
  return buildApp(deps, variant, service);
}
