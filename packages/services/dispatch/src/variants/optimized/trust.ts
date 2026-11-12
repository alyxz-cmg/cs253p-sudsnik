import { ok } from "@sudsnik/kernel";
import type { IngestTrust, PodCallback } from "../../ingest.js";
import { stepIndex } from "../../ingest.js";
import type { Store } from "../../store.js";
import { checksumVerifies } from "../../checksum.js";
import { createHash } from "node:crypto";

export function checksumOf(payload: any): string {
  const copy = { ...payload };
  delete copy.checksum;

  const sortedKeys = Object.keys(copy).sort();
  const canonical = JSON.stringify(copy, sortedKeys);

  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}
export function optimizedTrust(store: Store): IngestTrust {
  return {
    verify(body) {
      if (!body.checksum) return false;
      return checksumOf(body) === body.checksum;
    },

    fresh(entry, nowMs) {
      return store.recordCallback(entry, nowMs);
    },

    range(body: PodCallback, progress: number) {
      const target = stepIndex(body.kind);

      // Already-applied steps do not need to be replayed.
      if (progress >= target) return ok(undefined);

      // Apply any missing intermediate steps as well.
      return ok({
        from: progress + 1,
        to: target,
      });
    },
  };
}