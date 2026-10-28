import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness, SELECTED, type Harness } from "../helpers.js";

describe("durable hold storage", () => {
  it("keeps a live hold across a process restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sudsnik-hold-restart-"));
    let first: Harness | undefined;
    let second: Harness | undefined;
    try {
      first = await harness(SELECTED, undefined, dataDir);
      const acquired = await first.acquire("B", "survives-restart");
      expect(acquired.status).toBe(201);
      const hold = acquired.body;
      expect((await first.status("B")).body.washers.find((w) => w.washerId === hold.washerId)?.state).toBe("held");

      await first.close();
      first = undefined;

      second = await harness(SELECTED, undefined, dataDir);
      expect((await second.status("B")).body.washers.find((w) => w.washerId === hold.washerId)).toMatchObject({ state: "held", holdId: hold.holdId });

      // The fresh fake firmware does not retain its old process's token, but the service must still find and
      // transition the durable hold. Firmware-release refusal is logged and does not undo the local release.
      expect((await second.release(hold.holdId, "restart recovery")).status).toBe(200);
      expect((await second.status("B")).body.washers.find((w) => w.washerId === hold.washerId)?.state).toBe("idle");
      expect((await second.events("hold.released")).map((e) => e.payload)).toContainEqual({
        holdId: hold.holdId,
        washerId: hold.washerId,
        orderId: "survives-restart",
        reason: "restart recovery",
      });
    } finally {
      if (first) await first.close();
      if (second) await second.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
