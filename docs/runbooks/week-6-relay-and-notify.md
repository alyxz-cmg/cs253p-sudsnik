# Relay ingest and notification delivery

## `dispatch.relay_anomaly`

This alert means dispatch observed a repeated callback ID, a rejected callback,
or a callback timestamp older than one already received.

1. Inspect the dispatch `rejected_callbacks` table for the tenant, callback ID,
   reason, and received time.
2. For checksum failures, compare the stored body with the relay's delivery
   record. Do not replay an unchanged corrupt body.
3. For repeats, verify the `(tenant_id, callback_id)` identity. A repeat is
   acknowledged but must not publish the pod step a second time.
4. For out-of-order callbacks, inspect the order progress. The optimized
   ingest applies missing earlier steps when a later step arrives first.

## `dispatch.stalled_orders`

This alert means at least one non-terminal order has not changed state for two
orbits. The counter continues to advance while the condition remains present,
so the alert is repeated once per orbit.

Inspect the order's state, `updated_at`, current pickup/return assignments,
and active hold. Determine whether the order is waiting on a provider, a
washer, or a missing relay callback. Do not mark an order terminal just to
silence the alert; make the underlying state transition and publish its
corresponding event.

## `notify.relay_failures`

This alert fires after at least two new relay delivery failures since the
previous alert evaluation. Check the notification state, delivery attempts,
`not_before`, and habitat link window. Retryable failures remain queued;
`Retry-After` must elapse before another attempt.

Notifications that exhaust their attempt budget or receive a permanent
refusal are stored in `dead_letters` and publish `notification.failed`.
The on-call operator reviews those rows and the downstream failure event.
Dead-lettered notifications are not automatically retried.

**Warning:** do not delete a dead-letter row or reset an attempt counter until
the failure reason is understood and an operator-approved recovery is ready.
