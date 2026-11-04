# `tracking`

Shuttle positions and pod locations. The position reads have deliberately different costs:

- `GET /positions/:shuttleId` always asks `ephemeris` and returns `source: "fresh"`; the successful answer refreshes the durable last-known position.
- `GET /positions/cached/:shuttleId` serves the persisted last-known position as `source: "cached"` while its age is within `SUDSNIK_TRACKING_CACHE_TTL_MS` (default five minutes). If missing or expired, it refreshes from `ephemeris` and returns the fresh answer.
- `GET /positions` asks once for each of the six shuttles concurrently and returns all six as fresh.
- `GET /pods/:podId` is the pod's last known place (`habitat`, `shuttle`, or `node`) built from the dispatch events consumed by `src/handlers/`, visible only to the pod's tenant.

`POST /callbacks/relay` accepts only position callbacks. The checksum is verified, the body id is deduped, the newest observation per shuttle is kept in `tracking.sqlite`, and `position.updated` is published through the outbox.

Tables in `tracking.sqlite`: `positions` (last-known position per shuttle), `pod_locations`, `callbacks`, `handled`, `rejected_callbacks`, and the outbox.
