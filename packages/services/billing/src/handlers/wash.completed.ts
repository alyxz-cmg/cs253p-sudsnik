import type { Envelope, Handler, ServiceDeps } from "@sudsnik/contracts";
import { err, sudsnikError, type Result } from "@sudsnik/kernel";
import { billingServiceFor } from "../core/serviceSink.js";

class WashCompletedHandler implements Handler<"wash.completed"> {
  readonly topic = "wash.completed" as const;
  async handle(envelope: Envelope<"wash.completed">, deps: ServiceDeps): Promise<Result<void>> {
    const svc = billingServiceFor(deps);
    if (!svc) return err(sudsnikError("INTERNAL", "billing service not bound"));
    return svc.onWashCompleted(envelope);
  }
}

export default new WashCompletedHandler();