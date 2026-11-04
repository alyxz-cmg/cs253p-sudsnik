import type { Ctx, ServiceDeps } from "@sudsnik/contracts";
import type { Result } from "@sudsnik/kernel";
import type { NodeRanker } from "./holds.js";
import type { IngestTrustFactory } from "./ingest.js";
import type { Store } from "./store.js";
import type { WindowSource } from "./windows.js";

/** What differs between variants: how ephemeris is consulted and how far a relay callback is taken at its word. */
export interface Strategy {
  windows: WindowSource;
  nodes: NodeRanker;
  /** Whether a shuttle can leave the node now; the return window waits otherwise. */
  inContact(nodeId: string, ctx: Ctx): Promise<Result<boolean>>;
  /** Work the variant insists on before each pickup is planned. */
  beforePickup?(ctx: Ctx): Promise<Result<void>>;
  /** Keep retryable scheduling and hold failures queued indefinitely instead of terminally failing an order. */
  queueForever: boolean;
  ingest: IngestTrustFactory;
}

export type StrategyFactory = (deps: ServiceDeps, store: Store) => Strategy;
