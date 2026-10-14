import type { Envelope, ServiceDeps } from "@sudsnik/contracts";
import type { Result } from "@sudsnik/kernel";

export interface BillingServiceSink {
  onOrderReturned(envelope: Envelope<"order.returned">): Promise<Result<void>>;
  onWashCompleted(envelope: Envelope<"wash.completed">): Promise<Result<void>>;
  onOperatorUpdated(envelope: Envelope<"operator.updated">): Promise<Result<void>>;
}

const sinks = new WeakMap<ServiceDeps, BillingServiceSink>();

export function bindBillingService(deps: ServiceDeps, sink: BillingServiceSink): void {
  sinks.set(deps, sink);
}

export function billingServiceFor(deps: ServiceDeps): BillingServiceSink | undefined {
  return sinks.get(deps);
}