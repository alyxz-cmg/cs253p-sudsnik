import { fileURLToPath } from "node:url";
import type { ServiceDeps } from "@sudsnik/contracts";
import { buildApp, type SupportApp } from "../../app.js";
import { createOracleWorkflow } from "./workflow.js";

export const variant = "oracle";
export const handlersDir = fileURLToPath(new URL("../../handlers/", import.meta.url));

export function createApp(deps: ServiceDeps): Promise<SupportApp> {
  return buildApp(deps, {
    variant,
    workflow: ({ deps: serviceDeps, store, env }) => createOracleWorkflow({ deps: serviceDeps, store, env }),
  });
}
