import type { Hold, HoldStore } from "@sudsnik/contracts/services/washnodes";
import type { Result } from "@sudsnik/kernel";

/** Extra operations needed to reserve durably before the slow firmware round trip. */
export interface DurableHoldStore extends HoldStore {
  beginAcquire(input: {
    nodeId: string;
    orderId: string;
    tenantId: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<Result<Hold>>;

  /** Replaces the temporary firmware reference after the provider successfully creates its hold. */
  finalizeAcquire(
    holdId: string,
    expectedVersion: number,
    firmwareRef: string,
    expiresAt: number,
    nowMs: number,
  ): Promise<Result<Hold>>;
}

