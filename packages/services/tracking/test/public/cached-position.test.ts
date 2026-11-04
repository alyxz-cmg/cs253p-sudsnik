import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeDeps } from "@sudsnik/contracts/testing";
import type { App, SudsnikApp } from "@sudsnik/infra-http";
import type { Outbox } from "@sudsnik/infra-queue";
import { createApp } from "../../src/index.js";
import { deps as makeDeps, fakeEphemeris, positionCallback, tenant } from "../helpers.js";

describe("cached positions", () => {
  let deps: FakeDeps;
  let app: App & { sudsnik: SudsnikApp; outbox: Outbox };
  let ephemeris: { calls: number };

  beforeAll(async () => {
    deps = makeDeps();
    ephemeris = fakeEphemeris(deps, 0.75, 9_000);
    app = await createApp(deps);
  });
  afterAll(() => app.sudsnik.drain());

  it("uses the persisted last-known position without calling ephemeris", async () => {
    const callback = await app.inject({
      method: "POST",
      url: "/callbacks/relay",
      headers: tenant(),
      payload: positionCallback("sh1", 0.5, 1_000),
    });
    expect(callback.statusCode).toBe(200);

    const before = ephemeris.calls;
    const result = await app.inject({ url: "/positions/cached/sh1", headers: tenant() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ shuttleId: "sh1", orbitPhase: 0.5, observedAt: 1_000, source: "cached" });
    expect(ephemeris.calls).toBe(before);
  });

  it("refreshes a cached position after the configured TTL", async () => {
    const callback = await app.inject({
      method: "POST",
      url: "/callbacks/relay",
      headers: tenant(),
      payload: positionCallback("sh1", 0.5, 1_000, "sh1-ttl"),
    });
    expect(callback.statusCode).toBe(200);
    deps.clock.advanceTo(301_001);

    const before = ephemeris.calls;
    const result = await app.inject({ url: "/positions/cached/sh1", headers: tenant() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ shuttleId: "sh1", source: "fresh" });
    expect(ephemeris.calls).toBe(before + 1);
  });
});
