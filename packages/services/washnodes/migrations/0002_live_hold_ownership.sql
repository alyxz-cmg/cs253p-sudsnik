-- Expand: add an index safe for the old service to run alongside the new store.
create index if not exists holds_washer_state on holds (washer_id, state);

-- Contract invariant: a washer can have at most one live hold row.
-- The old Map-backed adapter wrote no rows to holds, so this is additive for existing installations.
create unique index if not exists holds_one_live_per_washer
  on holds (washer_id)
  where state = 'held';
