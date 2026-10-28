import type { Hold } from "@sudsnik/contracts/services/washnodes";
import type { Db } from "@sudsnik/infra-db";
import { err, newId, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { guardTransition, isPendingFirmwareRef, pendingFirmwareRef, publicHold, type StoredHold } from "../../domain/hold.js";
import type { DurableHoldStore } from "../../ports/holdStore.js";

type Row = { hold_id: string; tenant_id: string; node_id: string; washer_id: string; order_id: string; state: Hold["state"]; acquired_at: number; expires_at: number; version: number; firmware_ref: string };
type Washer = { washer_id: string };
type Input = { nodeId: string; orderId: string; tenantId: string; nowMs: number; ttlMs: number };
const stored = (r: Row): StoredHold => ({ holdId: r.hold_id, tenantId: r.tenant_id, nodeId: r.node_id, washerId: r.washer_id, orderId: r.order_id, state: r.state, acquiredAt: r.acquired_at, expiresAt: r.expires_at, version: r.version, firmwareRef: r.firmware_ref });
const load = (db: Db, id: string) => db.readOne<Row>("select hold_id, tenant_id, node_id, washer_id, order_id, state, acquired_at, expires_at, version, firmware_ref from holds where hold_id = ?", id);
const atomic = <T>(db: Db, fn: () => Result<T>): Result<T> => {
  try { return db.sqlite.transaction(fn).immediate(); }
  catch (e) { return err(sudsnikError("INTERNAL", `hold-store transaction failed: ${String(e)}`)); }
};

function reserve(db: Db, input: Input, requestedWasher?: string): Result<StoredHold> {
  return atomic(db, () => {
    const clause = requestedWasher ? " and washer_id = ?" : "";
    const args = requestedWasher ? [input.nodeId, requestedWasher] : [input.nodeId];
    const washer = db.read<Washer>(`select washer_id from washers where node_id = ? and state = 'idle' and maintenance = 0${clause} order by idx limit 1`, ...args)[0];
    if (!washer) return err(sudsnikError("QUOTA", `no idle washer at node ${input.nodeId}`));
    const id = newId(), ref = pendingFirmwareRef(id), expiresAt = input.nowMs + input.ttlMs;
    if (db.write("update washers set state = 'held', hold_id = ? where washer_id = ? and state = 'idle' and maintenance = 0", id, washer.washer_id).changes !== 1)
      return err(sudsnikError("QUOTA", `no idle washer at node ${input.nodeId}`));
    db.write("insert into holds (hold_id, tenant_id, node_id, washer_id, order_id, state, acquired_at, expires_at, version, firmware_ref) values (?, ?, ?, ?, ?, 'held', ?, ?, 0, ?)", id, input.tenantId, input.nodeId, washer.washer_id, input.orderId, input.nowMs, expiresAt, ref);
    return ok({ holdId: id, tenantId: input.tenantId, nodeId: input.nodeId, washerId: washer.washer_id, orderId: input.orderId, state: "held", acquiredAt: input.nowMs, expiresAt, version: 0, firmwareRef: ref });
  });
}

function finalize(db: Db, id: string, version: number, ref: string, expiresAt: number, nowMs: number): Result<StoredHold> {
  return atomic(db, () => {
    const row = load(db, id);
    if (!row) return err(sudsnikError("NOT_FOUND", `no hold ${id}`));
    const current = stored(row), guarded = guardTransition(current, id, version);
    if (!guarded.ok) return guarded;
    if (!isPendingFirmwareRef(current.firmwareRef)) return err(sudsnikError("CONFLICT", `hold ${id} already has a firmware reference`));
    if (expiresAt <= nowMs) {
      db.write("update holds set state = 'expired', version = version + 1, ended_at = ? where hold_id = ? and state = 'held' and version = ?", nowMs, id, version);
      db.write("update washers set state = 'idle', hold_id = null where washer_id = ? and hold_id = ?", current.washerId, id);
      return err(sudsnikError("CONFLICT", `firmware hold for ${id} has already expired`));
    }
    if (db.write("update holds set firmware_ref = ?, expires_at = ? where hold_id = ? and state = 'held' and version = ? and firmware_ref = ?", ref, expiresAt, id, version, current.firmwareRef).changes !== 1)
      return err(sudsnikError("CONFLICT", `hold ${id} changed during acquisition`));
    const saved = load(db, id);
    return saved ? ok(stored(saved)) : err(sudsnikError("NOT_FOUND", `no hold ${id}`));
  });
}

function transition(db: Db, id: string, version: number, state: "released" | "consumed", nowMs: number, reason?: string): Result<StoredHold> {
  return atomic(db, () => {
    const row = load(db, id);
    if (!row) return err(sudsnikError("NOT_FOUND", `no hold ${id}`));
    const current = stored(row), guarded = guardTransition(current, id, version);
    if (!guarded.ok) return guarded;
    if (state === "consumed" && !db.readOne<Washer>("select washer_id from washers where washer_id = ? and state = 'held' and hold_id = ?", current.washerId, id))
      return err(sudsnikError("CONFLICT", `washer ${current.washerId} is no longer reserved by hold ${id}`));
    if (db.write("update holds set state = ?, version = version + 1, ended_at = ?, reason = ? where hold_id = ? and state = 'held' and version = ?", state, nowMs, reason ?? null, id, version).changes !== 1)
      return err(sudsnikError("CONFLICT", `hold ${id} changed during transition`));
    if (state === "consumed") {
      if (db.write("update washers set state = 'washing' where washer_id = ? and state = 'held' and hold_id = ?", current.washerId, id).changes !== 1) throw new Error(`washer ${current.washerId} changed during consume`);
    } else db.write("update washers set state = 'idle', hold_id = null where washer_id = ? and hold_id = ?", current.washerId, id);
    const saved = load(db, id);
    return saved ? ok(stored(saved)) : err(sudsnikError("NOT_FOUND", `no hold ${id}`));
  });
}

export function sqliteHoldStore(db: Db): DurableHoldStore {
  const finish = async (id: string, version: number, ref: string, expiresAt: number, nowMs: number): Promise<Result<Hold>> => {
    const r = finalize(db, id, version, ref, expiresAt, nowMs);
    return r.ok ? ok(publicHold(r.value)) : r;
  };
  return {
    beginAcquire: async (input) => { const r = reserve(db, input); return r.ok ? ok(publicHold(r.value)) : r; },
    finalizeAcquire: finish,
    acquire: async (input) => {
      if (!input.firmwareRef) return err(sudsnikError("INTERNAL", `hold for order ${input.orderId} has no firmware reference`));
      const r = reserve(db, input, input.washerId);
      if (!r.ok) return r;
      return finish(r.value.holdId, r.value.version, input.firmwareRef, input.nowMs + input.ttlMs, input.nowMs);
    },
    release: async (id, version, reason, nowMs) => { const r = transition(db, id, version, "released", nowMs, reason); return r.ok ? ok(publicHold(r.value)) : r; },
    consume: async (id, version, nowMs) => { const r = transition(db, id, version, "consumed", nowMs); return r.ok ? ok(publicHold(r.value)) : r; },
    expire: async (nowMs) => {
      const r = atomic(db, () => {
        const rows = db.read<Row>("select hold_id, tenant_id, node_id, washer_id, order_id, state, acquired_at, expires_at, version, firmware_ref from holds where state = 'held' and expires_at < ? order by expires_at", nowMs);
        const ended: StoredHold[] = [];
        for (const row of rows) {
          if (db.write("update holds set state = 'expired', version = version + 1, ended_at = ? where hold_id = ? and state = 'held' and version = ? and expires_at < ?", nowMs, row.hold_id, row.version, nowMs).changes !== 1) continue;
          db.write("update washers set state = 'idle', hold_id = null where washer_id = ? and hold_id = ?", row.washer_id, row.hold_id);
          // A crash may leave the durable reservation pending before the firmware ref arrived.
          // It still needs a terminal event so the system never silently forgets a held row.
          ended.push({ ...stored(row), state: "expired", version: row.version + 1 });
        }
        return ok(ended);
      });
      return r.ok ? ok(r.value.map(publicHold)) : r;
    },
    get: async (id) => {
      const row = load(db, id);
      return row
        ? ok(publicHold(stored(row)))
        : err(sudsnikError("NOT_FOUND", `no hold ${id}`));
    },
  };
}
