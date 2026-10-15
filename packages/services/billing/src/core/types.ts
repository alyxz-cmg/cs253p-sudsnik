export type ChargeRow = {
  charge_id: string;
  order_id: string;
  tenant_id: string;
  payment_ref: string;
  state: "authorized" | "captured" | "failed" | "refunded";
  amount: number;
  currency: string;
  created_at: number;
};

export type LedgerRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  kind: "authorize" | "capture" | "refund" | "fee";
  amount: number;
  currency: string;
  at: number;
  ref: string | null;
};
