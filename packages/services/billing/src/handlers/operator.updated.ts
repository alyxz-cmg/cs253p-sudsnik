import type { Envelope, Handler, ServiceDeps } from "@sudsnik/contracts";
import { err, sudsnikError, type Result } from "@sudsnik/kernel";
import { billingServiceFor } from "../core/serviceSink.js";

class OperatorUpdatedHandler implements Handler<"operator.updated"> {
  readonly topic = "operator.updated" as const;
  async handle(envelope: Envelope<"operator.updated">, deps: ServiceDeps): Promise<Result<void>> {
    const svc = billingServiceFor(deps);
    if (!svc) return err(sudsnikError("INTERNAL", "billing service not bound"));
    return svc.onOperatorUpdated(envelope);
  }
}

export default new OperatorUpdatedHandler();