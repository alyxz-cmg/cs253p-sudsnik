alter table relay_callbacks rename to relay_callbacks_v1;

create table relay_callbacks (
  id text not null,
  tenant_id text not null,
  kind text not null,
  order_id text,
  received_at integer not null,
  primary key (tenant_id, id)
);

insert or ignore into relay_callbacks (id, tenant_id, kind, order_id, received_at)
select id, tenant_id, kind, order_id, received_at from relay_callbacks_v1;

drop table relay_callbacks_v1;

delete from rejected_callbacks
where callback_id is not null
  and seq not in (
    select min(seq)
    from rejected_callbacks
    where callback_id is not null
    group by tenant_id, callback_id
  );

create unique index rejected_callbacks_once
  on rejected_callbacks (tenant_id, callback_id)
  where callback_id is not null;

create index orders_stale on orders (updated_at, state);
