import type { ServiceDeps } from "@sudsnik/contracts";
import { bootService } from "@sudsnik/infra-boot";
import { sqliteCycleRepo } from "../../adapters/db/cycleRepo.js";
import { sqliteWasherRepo } from "../../adapters/db/washerRepo.js";
import { sqliteHoldStore } from "../../adapters/holdStore/sqlite.js";
import { RECONCILE, composeApp, sharedHandlersDir, type AppOptions, type Profile, type WashnodesApp } from "../../app/compose.js";
import { readEnv } from "../../env.js";

export const variant = "sqlite";
export const handlersDir = sharedHandlersDir;
export const profile: Profile = {
  washers: (db) => sqliteWasherRepo(db),
  holds: (db) => sqliteHoldStore(db),
  cycles: sqliteCycleRepo,
  reconcile: RECONCILE,
};

export const createApp = (deps: ServiceDeps, opts?: AppOptions): Promise<WashnodesApp> => composeApp(deps, variant, profile, opts);
export const start = async (): Promise<void> => void (await bootService({ service: "washnodes", readEnv, createApp, handlersDir }));
export { readEnv };
