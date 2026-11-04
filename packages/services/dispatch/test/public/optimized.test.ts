import { afterEach, describe, expect, it } from "vitest";
import { sudsnikError } from "@sudsnik/kernel";
import { createApp } from "../../src/index.js";
import { buildDeps, buildOrderPlaced, stubClients } from "../support/builders.js";

const apps: Array<{ sudsnik: { drain(): Promise<void> } }> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.sudsnik.drain();
});

describe("Week 5 dispatch strategy", () => {
  it("shares habitat windows and node status across orders in the same orbit", async () => {
    const deps = buildDeps();
    const calls = stubClients(deps);
    const app = await createApp(deps);
    apps.push(app);

    await deps.bus.deliver(buildOrderPlaced({ podId: "hab01-p001" }));
    await deps.bus.deliver(buildOrderPlaced({ podId: "hab01-p002" }));

    expect(calls.windows).toBe(1);
    expect(calls.status).toBe(3);
    expect(calls.position).toBe(0);
    expect(deps.bus.ofTopic("pickup.scheduled")).toHaveLength(2);
  });

  it("opens on the first quota refusal and schedules from local policy while open", async () => {
    const deps = buildDeps();
    stubClients(deps);
    let refusals = 0;
    deps.clients.ephemeris.status = async () => {
      refusals++;
      return { ok: false, error: sudsnikError("QUOTA", "quota spent") };
    };
    const app = await createApp(deps);
    apps.push(app);

    await deps.bus.deliver(buildOrderPlaced({ podId: "hab01-p001" }));
    await deps.bus.deliver(buildOrderPlaced({ podId: "hab01-p002" }));

    expect(refusals).toBe(1);
    expect(deps.bus.ofTopic("pickup.scheduled")).toHaveLength(2);
    expect(deps.bus.ofTopic("pickup.failed")).toHaveLength(0);
  });

  it("keeps an order queued rather than terminally failing after repeated non-retryable planning errors", async () => {
    const deps = buildDeps();
    stubClients(deps);
    deps.clients.ephemeris.windows = async () => ({
      ok: false,
      error: sudsnikError("NOT_FOUND", "unavailable habitat fixture"),
    });
    const app = await createApp(deps);
    apps.push(app);
    await deps.bus.deliver(buildOrderPlaced());

    for (let minute = 1; minute <= 31; minute++) {
      deps.clock.advanceTo(minute * 60_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(deps.bus.ofTopic("pickup.failed")).toHaveLength(0);
    expect(deps.bus.ofTopic("pickup.scheduled")).toHaveLength(0);
  });
});
