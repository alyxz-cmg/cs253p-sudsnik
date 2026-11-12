import { MINUTE_MS, ORBIT_MS } from "@sudsnik/contracts";
import type { AlertRule } from "@sudsnik/contracts";

let observed = 0;
let lastAlertAt = -ORBIT_MS;

const rule: AlertRule = {
  name: "dispatch.stalled_orders",
  every: MINUTE_MS,
  evaluate({ counters, nowMs }) {
    const current = counters["dispatch.stalled_orders"] ?? 0;
    if (current <= observed) return false;
    observed = current;

    // Continue alerting once per orbit while the stalled condition remains active.
    if (nowMs - lastAlertAt < ORBIT_MS) return false;
    lastAlertAt = nowMs;
    return true;
  },
};

export default rule;
