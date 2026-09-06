-- =====================================================================
-- Warehouse stock ledger, batch by batch
-- Repo path: supabase/migrations/20260906000002_stock_ledger_report.sql
--
-- A shop deciding what to ask for needs to know three things the current
-- screens do not put together:
--
--   * what is physically on the warehouse shelf
--   * how much of it is already promised to other branches - approved
--     requests that have not been picked yet
--   * when each batch expires, so an order can be timed against it
--
-- Without the middle one a warehouse showing 500 can be down to 80 free,
-- and the shop only finds out when its request comes back rejected.
--
-- Cost stays out of the shop's view. A branch needs to know how many are
-- there, not what the company paid; the same function returns cost to the
-- management tier and nulls it for everyone else.
--
-- One row per batch: a product with three deliveries appears three times,
-- because "500 in stock" is a worse answer than "200 expiring next month,
-- 300 the year after".
--
-- Idempotent - safe to re-run.
-- =====================================================================

create or replace function public.warehouse_stock_ledger(p_warehouse_id text)
returns table (
  product_id      uuid,
  variant_id      uuid,
  item_name       text,
  barcode         text,
  warehouse_id    text,
  batch_id        uuid,
  expiry_date     date,
  batch_qty       numeric,   -- units left in this batch
  on_hand         numeric,   -- units across every batch of this item
  committed       numeric,   -- approved but not yet dispatched
  free            numeric,   -- on hand less what is promised elsewhere
  unit_cost       numeric,   -- null unless the caller may see cost
  batch_value     numeric    -- null unless the caller may see cost
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
    select sr.product_id,
           sr.variant_id,
           sum(sr.requested_qty) as qty
    from public.stock_requests sr
    where sr.requested_warehouse_id = p_warehouse_id
      and sr.status = 'approved'
    group by sr.product_id, sr.variant_id
  ),
  on_hand_qty as (
    select si.product_id, si.variant_id, si.stock_qty
    from public.store_inventory si
    where si.store_id = p_warehouse_id
  )
  select
    b.product_id,
    b.variant_id,
    case
      when pv.variant_name is not null then p.name || ' (' || pv.variant_name || ')'
      else p.name
    end,
    coalesce(pv.sku, p.sku),
    p_warehouse_id,
    b.id,
    b.expiry_date,
    b.remaining_qty,
    coalesce(oh.stock_qty, 0),
    coalesce(c.qty, 0),
    coalesce(oh.stock_qty, 0) - coalesce(c.qty, 0),
    case when v_show_cost then b.unit_cost else null end,
    case when v_show_cost then b.remaining_qty * coalesce(b.unit_cost, 0) else null end
  from public.stock_purchases b
  join public.products p on p.id = b.product_id
  left join public.product_variants pv on pv.id = b.variant_id
  left join on_hand_qty oh
    on oh.product_id = b.product_id
   and oh.variant_id is not distinct from b.variant_id
  left join committed_qty c
    on c.product_id = b.product_id
   and c.variant_id is not distinct from b.variant_id
  where b.store_id = p_warehouse_id
    and b.remaining_qty > 0
  order by p.name, b.expiry_date asc nulls last;
end;
$$;

revoke all on function public.warehouse_stock_ledger(text) from public, anon;
grant execute on function public.warehouse_stock_ledger(text) to authenticated;
