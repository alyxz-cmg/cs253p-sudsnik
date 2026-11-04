# `@sudsnik/service-dispatch`

Shuttle assignment for the physical flow: a pickup window and a wash-node hold for every placed order, a return window
when the wash completes, and ingest of the relay's `collected`, `delivered`, and `returned` callbacks. The contract is
`packages/contracts/src/services/dispatch/`, and what the service owes is `docs/system-spec.md` §9.4.

The selected `optimized` strategy keeps orbital reads cheap without changing the dispatch contract:

- Habitat link windows are cached per tenant, habitat, and orbit. Simultaneous misses share one provider request.
- Node status is cached per tenant and node only until the provider's 60-second status cache would expire. Same-key misses are coalesced.
- A tenant-scoped circuit breaker opens on the first retryable ephemeris refusal. While open, dispatch uses the canon link schedule and persisted round-robin node choice. It permits a half-open probe after one orbit.
- Dispatch does not fetch shuttle positions during scheduling. `position.updated` remains an informational, operator-facing read model; the scheduling algorithm does not use it.

The existing scheduler is the back-pressure mechanism: it claims FIFO batches up to `SUDSNIK_DISPATCH_MAX_INFLIGHT`, keeps overflow in `dispatch.sqlite`, wakes washer waiters on release/expiry/completion, and uses an orbit sweep as a recovery backstop. The optimized strategy never terminally gives up on a queued pickup or washer hold, so transient provider pressure cannot turn an accepted order into a system cancellation or permanent failure.

Modules by concern under `src/`: `scheduler.ts` (pickup, return, reassign, cancel, and the back-pressure queue), `holds.ts`
(node ranking and holds through `washnodes`), `shuttles.ts` (round-robin with trip capacity), `windows.ts` (link windows and
per-orbit cache), `ingest.ts` (relay callbacks), `store.ts` (every SQL statement), `publisher.ts` (events through the outbox),
`runtime.ts` (how directory-scanned handlers reach the app), `gate.ts` (the drain), and `app.ts` (the shared app).

Tables in `dispatch.sqlite` (`migrations/`): `orders`, `assignments`, `holds`, `trips`, `rotation`, `shuttle_positions`,
`consumed_events`, `relay_callbacks`, `rejected_callbacks`, and the outbox.

On `SIGTERM` the stops run in reverse registration order: timers and consumers stop, the gate waits for in-flight routes,
deliveries, and sweeps, the outbox publishes what they wrote, and the database closes last.
