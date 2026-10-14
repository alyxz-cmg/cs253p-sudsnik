import type { Envelope, Handler, ServiceDeps } from "@sudsnik/contracts";
import { err, sudsnikError, type Result } from "@sudsnik/kernel";
import { billingServiceFor } from "../core/serviceSink.js";

export default class OperatorUpdatedHandler implements Handler<"operator.updated"> {
  readonly topic = "operator.updated" as const;

  async handle(envelope: Envelope<"operator.updated">, deps: ServiceDeps): Promise<Result<void>> {
    const svc = billingServiceFor(deps);
    if (!svc) {
      return err(sudsnikError("INTERNAL", "billing service not bound; createApp(deps) has not run for these deps"));
    }
    return svc.onOperatorUpdated(envelope);
  }
}