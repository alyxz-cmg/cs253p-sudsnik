import { MINUTE_MS } from "@sudsnik/contracts";
import type { AlertRule } from "@sudsnik/contracts";

let observed = 0;

const rule: AlertRule = {
  name: "notify.relay_failures",
  every: MINUTE_MS,
  evaluate({ counters }) {
    const current = counters["notify.relay_failures"] ?? 0;
    if (current - observed < 2) return false;
    observed = current;
    return true;
  },
};

export default rule;
