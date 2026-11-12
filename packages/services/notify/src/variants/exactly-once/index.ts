import { fileURLToPath } from "node:url";
import type { ServiceDeps } from "@sudsnik/contracts";
import { bootService } from "@sudsnik/infra-boot";
import { createServiceApp, handlersDir, type NotifyApp, type VariantRuntime, type Wiring } from "../../app.js";
import { send, settle, stillPending, type DeliveryState } from "../../delivery/relay.js";
import { inLinkWindow } from "../../delivery/window.js";
import { readEnv } from "../../env.js";
import { next, pipeline, stage } from "../../pipeline.js";
import { parse, persist, render, resolve, type IngestState } from "../../queue/ingest.js";
import { ingestWith, observer, port, sweeper } from "../../service.js";

export const variant = "exactly-once";
export { readEnv, handlersDir };

const alertsDir = fileURLToPath(new URL("../../alerts/", import.meta.url));
const initialState = (habitatId: string, now: number) =>
  inLinkWindow(habitatId, now) ? ("queued" as const) : ("digested" as const);

/** At-least-once ingestion with tenant-scoped dedupe and durable retry/dead-letter delivery. */
export function runtime(w: Wiring): VariantRuntime {
  const observe = observer(w.deps);
  const deliver = pipeline<DeliveryState>(
    "deliver",
    [
      send(w),
      settle(w, { maxAttempts: 5, honorRetryAfter: true }),
    ],
    observe,
  );
  const pending = sweeper({ w, deliver });

  const dispatch = stage<IngestState>("dispatch", async (s) => {
    if (s.notification) {
      const outcome = await deliver({ notification: s.notification, now: s.now, attempt: 0 });
      if (stillPending(outcome)) pending.notePending();
    }
    return next(s);
  });
  const ingest = pipeline<IngestState>(
    "ingest",
    [
      parse(),
      resolve(w),
      render(),
      persist(w, {
        first: (ctx, envelopeId, tenantId, notificationId, now) =>
          ctx.store.markSeen(tenantId, envelopeId, notificationId, now),
        initialState,
      }),
      dispatch,
    ],
    observe,
  );
  const api = port({
    w,
    deliver,
    initialState,
    dispatchOnWrite: inLinkWindow,
    onPending: pending.notePending,
  });

  return {
    ingest: (envelope) => ingestWith(ingest, w.deps, envelope),
    send: api.send,
    digest: api.digest,
    sweep: pending.sweep,
    stop: pending.stop,
  };
}

export function createApp(deps: ServiceDeps): Promise<NotifyApp> {
  return createServiceApp(deps, { variant, runtime, alertsDir });
}

export function start(): Promise<unknown> {
  return bootService({
    service: "notify",
    readEnv,
    createApp,
    handlersDir,
  });
}