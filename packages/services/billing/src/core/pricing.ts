import { WASH_PRICE_MINOR, CYCLE_UNIT_PRICE_MINOR, EXPECTED_CYCLE_UNITS, DEFAULT_CURRENCY } from "@sudsnik/contracts/canon";

export function computeWashQuote(orderId: string, tier: "standard" | "priority", cycleUnits = EXPECTED_CYCLE_UNITS) {
  const base = WASH_PRICE_MINOR[tier];
  const amount = base + cycleUnits * CYCLE_UNIT_PRICE_MINOR;
  return {
    orderId,
    amount,
    currency: DEFAULT_CURRENCY,
    breakdown: { base, cycleUnits, tier },
  };
}
