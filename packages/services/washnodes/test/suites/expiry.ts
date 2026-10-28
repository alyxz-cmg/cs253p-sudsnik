import { describe, expect, it } from "vitest";
import { HOLD_TTL_MS, MINUTE_MS, ORBIT_MS } from "@sudsnik/contracts";
import { harness, type Variant } from "../helpers.js";


/** The behaviour every variant of this seam owes, run once per variant a tree has. */
export function expirySuite(variants: Variant[]): void {
  describe.each(variants)("$name hold expiry", (variant) => {
    it("expires a hold one orbit after it was acquired, publishes hold.expired once, and frees the washer", async () => {
      const h = await harness(variant);
      const hold = (await h.acquire("B", "o1")).body;
      await h.advance(HOLD_TTL_MS - MINUTE_MS);
      expect(await h.events("hold.expired")).toHaveLength(0);
      await h.advance(MINUTE_MS);
      // The exact expiresAt boundary is still valid; the next sweep, one minute later, expires it.
      expect(await h.events("hold.expired")).toHaveLength(0);
      await h.advance(MINUTE_MS);
      expect((await h.events("hold.expired")).map((e) => e.payload)).toEqual([{ holdId: hold.holdId, washerId: hold.washerId, orderId: "o1" }]);
      await h.advance(2 * MINUTE_MS);
      expect(await h.events("hold.expired")).toHaveLength(1);
      expect((await h.status("B")).body.washers.find((w) => w.washerId === hold.washerId)?.state).toBe("idle");
      await h.close();
    });

    it("refuses to start a cycle on an expired hold with 409, and to release it", async () => {
      const h = await harness(variant);
      const hold = (await h.acquire("A", "o1")).body;
      await h.advance(ORBIT_MS + MINUTE_MS);
      const started = await h.start(hold.holdId);
      expect(started.status).toBe(409);
      expect(started.body).toMatchObject({ code: "CONFLICT" });
      expect((await h.release(hold.holdId)).status).toBe(409);
      expect(await h.events("wash.started")).toHaveLength(0);
      await h.close();
    });

    it("refuses to start a cycle whose hold is past expiresAt even before the sweep has run", async () => {
      const h = await harness(variant);
      const hold = (await h.acquire("A", "o1")).body;
      h.deps.clock.advanceTo(hold.expiresAt + 1);
      expect((await h.start(hold.holdId)).status).toBe(409);
      await h.close();
    });

    it("does not expire a consumed hold one orbit after its cycle starts", async () => {
      const h = await harness(variant);
      const hold = (await h.acquire("B", "o1")).body;
      await h.advance(30 * MINUTE_MS);
      expect((await h.start(hold.holdId)).status).toBe(201);
      await h.advance(HOLD_TTL_MS - 30 * MINUTE_MS + MINUTE_MS);
      expect(await h.events("hold.expired")).toHaveLength(0);
      expect((await h.status("B")).body.washers.find((w) => w.washerId === hold.washerId)?.state).toBe("washing");
      await h.close();
    });
  });
}
