import { ok } from "@sudsnik/kernel";
import type { IngestTrust, PodCallback } from "../../ingest.js";
import { stepIndex } from "../../ingest.js";
import type { Store } from "../../store.js";
import { checksumVerifies } from "../../checksum.js";

export function optimizedTrust(store: Store): IngestTrust {
  return {
    verify(body) {
      return checksumVerifies(
        body as unknown as Record<string, unknown>,
      );
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