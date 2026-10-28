import type { Hold, HoldStore } from "@sudsnik/contracts/services/washnodes";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";

/** A stored hold always carries the firmware's own reference to it: the v1 hold token or the v2 hold id. */
export interface StoredHold extends Hold {
  /** While acquire is in flight this is a private marker, never exposed by the API. */
  firmwareRef?: string;
}

export type AcquireInput = Parameters<HoldStore["acquire"]>[0];

export const PENDING_FIRMWARE_PREFIX = "__pending_firmware_ref__:";

export function pendingFirmwareRef(holdId: string): string {
  return `${PENDING_FIRMWARE_PREFIX}${holdId}`;
}

export function isPendingFirmwareRef(ref: string | undefined): boolean {
  return ref?.startsWith(PENDING_FIRMWARE_PREFIX) ?? false;
}

/** Never leak the internal in-flight marker through the public Hold response. */
export function publicHold(hold: StoredHold): Hold {
  const { firmwareRef, ...visible } = hold;
  return firmwareRef && !isPendingFirmwareRef(firmwareRef) ? { ...visible, firmwareRef } : visible;
}

export function isPastExpiry(hold: Hold, nowMs: number): boolean {
  // A hold may not start at its deadline; reject it as soon as expiresAt is reached.
  return hold.expiresAt <= nowMs;
}

/** The transition guard every store applies: the caller's version must match and the hold must still be held. */
export function guardTransition(hold: StoredHold | undefined, holdId: string, expectedVersion: number): Result<StoredHold> {
  if (!hold) return err(sudsnikError("NOT_FOUND", `no hold ${holdId}`));
  if (hold.version !== expectedVersion) return err(sudsnikError("CONFLICT", `hold ${holdId} is at version ${hold.version}, not ${expectedVersion}`));
  if (hold.state !== "held") return err(sudsnikError("CONFLICT", `hold ${holdId} is ${hold.state}`));
  return ok(hold);
}

/** The firmware reference a hold must carry to be released or started at the washer; `what` names the hold in the error. */
export function firmwareRefOf(firmwareRef: string | undefined, what: string): Result<string> {
  return firmwareRef && !isPendingFirmwareRef(firmwareRef) ? ok(firmwareRef) : err(sudsnikError("INTERNAL", `${what} has no firmware reference`));
}
