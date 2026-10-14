import type { Ctx } from "@sudsnik/contracts";
import { err, sudsnikError, type Result } from "@sudsnik/kernel";
import type {
  Charge,
  LedgerEntry,
  LedgerFilter,
  Quote,
} from "@sudsnik/contracts/services/billing";
import type { BillingService } from "../port.js";

const hollow = () => err(sudsnikError("UNAVAILABLE", "billing is hollow"));

export class HollowBillingService implements BillingService {
  async quote(orderId: string, ctx: Ctx): Promise<Result<Quote>> {
    return hollow();
  }

  async authorize(orderId: string, amount: number, ctx: Ctx): Promise<Result<Charge>> {
    return hollow();
  }

  async capture(orderId: string, ctx: Ctx): Promise<Result<Charge>> {
    return hollow();
  }

  async refund(orderId: string, ctx: Ctx): Promise<Result<Charge>> {
    return hollow();
  }

  async ledger(filter: LedgerFilter, ctx: Ctx): Promise<Result<LedgerEntry[]>> {
    return hollow();
  }
}