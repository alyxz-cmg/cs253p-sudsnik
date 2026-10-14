import type { Envelope, Handler, ServiceDeps } from "@sudsnik/contracts";
import { err, sudsnikError, type Result } from "@sudsnik/kernel";
import { billingServiceFor } from "../core/serviceSink.js";

class OrderReturnedHandler implements Handler<"order.returned"> {
  readonly topic = "order.returned" as const;
  async handle(envelope: Envelope<"order.returned">, deps: ServiceDeps): Promise<Result<void>> {
    const svc = billingServiceFor(deps);
    if (!svc) return err(sudsnikError("INTERNAL", "billing service not bound"));
    return svc.onOrderReturned(envelope);
  }
}

export default new OrderReturnedHandler();