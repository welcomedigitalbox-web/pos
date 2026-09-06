-- =====================================================================
-- Warehouse stock ledger, one row per item
-- Repo path: supabase/migrations/20260906000003_stock_ledger_by_item.sql
--
-- The first version returned a row per batch. That answers "when does each
-- delivery expire", but the question the report is actually for is "what
-- can I ask for" - and for that a line per delivery is noise. Each item
-- now appears once, carrying the earliest expiry among the batches still
-- holding stock, which is the date that matters first.
--
-- Cost stays out of a shop's view; the management tier sees it.
--
-- Idempotent - safe to re-run.
-- =====================================================================

drop function if exists public.warehouse_stock_ledger(text);

create or replace function public.warehouse_stock_ledger(p_warehouse_id text)
returns table (
  product_id      uuid,
  variant_id      uuid,
  item_name       text,
  barcode         text,
  warehouse_id    text,
  on_hand         numeric,   -- units on the shelf
  committed       numeric,   -- approved requests not yet dispatched
  free            numeric,   -- what is left to promise
  next_expiry     date,      -- earliest expiry still holding stock
  batches         integer,   -- how many deliveries make up the balance
  unit_cost       numeric,   -- null unless the caller may see cost
  stock_value     numeric    -- null unless the caller may see cost
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_show_cost boolean;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  if not public.can_read_store(p_warehouse_id) then
    raise exception 'you cannot read %', p_warehouse_id;
  end if;

  -- Department heads and above answer for stock value; a till does not.
  v_show_cost := public.is_approver_role(public.my_role());

  return query
  with committed_qty as (
    -- Approved means the warehouse head has taken the job on, so those
    -- units are spoken for even though they are still on the shelf.
    select sr.product_id, sr.variant_id, sum(sr.requested_qty) as qty
    from public.stock_requests sr
    where sr.requested_warehouse_id = p_warehouse_id
      and sr.status = 'approved'
    group by sr.product_id, sr.variant_id
  ),
  batch_roll as (
    select sp.product_id,
           sp.variant_id,
           min(sp.expiry_date) as next_expiry,
           count(*)::integer   as batches,
           sum(sp.remaining_qty * coalesce(sp.unit_cost, 0)) as value
    from public.stock_purchases sp
    where sp.store_id = p_warehouse_id
      and sp.remaining_qty > 0
    group by sp.product_id, sp.variant_id
  )
  select
    si.product_id,
    si.variant_id,
    case
      when pv.variant_name is not null then p.name || ' (' || pv.variant_name || ')'
      else p.name
    end,
    coalesce(pv.sku, p.sku),
    p_warehouse_id,
    si.stock_qty,
    coalesce(c.qty, 0),
    si.stock_qty - coalesce(c.qty, 0),
    b.next_expiry,
    coalesce(b.batches, 0),
    case when v_show_cost then si.avg_cost else null end,
    case when v_show_cost then si.stock_qty * coalesce(si.avg_cost, 0) else null end
  from public.store_inventory si
  join public.products p on p.id = si.product_id
  left join public.product_variants pv on pv.id = si.variant_id
  left join batch_roll b
    on b.product_id = si.product_id
   and b.variant_id is not distinct from si.variant_id
  left join committed_qty c
    on c.product_id = si.product_id
   and c.variant_id is not distinct from si.variant_id
  where si.store_id = p_warehouse_id
  order by p.name;
end;
$$;

revoke all on function public.warehouse_stock_ledger(text) from public, anon;
grant execute on function public.warehouse_stock_ledger(text) to authenticated;
