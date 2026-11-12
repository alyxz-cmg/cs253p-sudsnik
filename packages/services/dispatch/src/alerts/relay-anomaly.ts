import { MINUTE_MS } from "@sudsnik/contracts";
import type { AlertRule } from "@sudsnik/contracts";

let observed = 0;

const rule: AlertRule = {
  name: "dispatch.relay_anomaly",
  every: MINUTE_MS,
  evaluate({ counters }) {
    const current = counters["dispatch.relay_anomalies"] ?? 0;
    if (current <= observed) return false;
    observed = current;
    return true;
  },
};

export default rule;
