import type { Ctx } from "@sudsnik/contracts";
import { CANCELLABLE_STATES, type Order } from "@sudsnik/contracts/services/orders";
import { err, ok, sudsnikError, type Result } from "@sudsnik/kernel";
import { COMPENSATION, ORIGIN, notFound, OrdersService } from "../../core/OrdersService.js";

export class CancelNoopOrdersService extends OrdersService {
  async cancel(orderId: string, reason: string, ctx: Ctx): Promise<Result<Order>> {
    let result: Result<Order> | undefined;
    let cancelledOrder: Order | undefined;
    let refund = false;

    this.inTransaction(() => {
      const found = this.find(ctx.tenantId, orderId);
      if (!found) {
        result = err(notFound(orderId));
        return;
      }
      
      const order = this.refresh(found);

      if (order.state === "cancelled") {
        result = ok(order);
        return;
      }

      if (!CANCELLABLE_STATES.includes(order.state)) {
        result = err(sudsnikError("CONFLICT", `order ${orderId} is ${order.state}`));
        return;
      }

      const compensations = this.cancelInPlace(order, reason || "changed my mind", ORIGIN.customer, {
        correlationId: ctx.correlationId,
      });

      cancelledOrder = order;
      refund = compensations.includes(COMPENSATION.refund);
    });

    if (result) return result;

    if (cancelledOrder && refund) {
      await this.refundFor(cancelledOrder, ctx.correlationId);
    }
    
    return ok(cancelledOrder!);
  }
}