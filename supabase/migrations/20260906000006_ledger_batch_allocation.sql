-- =====================================================================
-- Warehouse stock ledger, one row per delivery
-- Repo path: supabase/migrations/20260906000006_ledger_batch_allocation.sql
--
-- Earlier versions repeated the item's whole balance on every batch row, so
-- a 300 delivery and a 500 delivery both read 800 and the expiry split the
-- rows exist to show meant nothing. Each row now carries its own numbers.
--
-- Approved requests name a product, not a batch, so the commitment has to
-- be placed. It goes against the batches that would be picked first -
-- earliest expiry, then oldest delivery - because that is the order the
-- stock will actually leave in. A commitment larger than the batch spills
-- into the next one, and anything still unplaced at the end (a request
-- approved against stock that is no longer there) lands on the last row,
-- where it shows as a negative free balance rather than disappearing.
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
  batch_id        uuid,
  expiry_date     date,
  on_hand         numeric,   -- units left in this delivery
  committed       numeric,   -- of those, already promised elsewhere
  free            numeric,   -- what is left to promise from this delivery
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
    select sr.product_id, sr.variant_id, sum(sr.requested_qty) as qty
    from public.stock_requests sr
    where sr.requested_warehouse_id = p_warehouse_id
      and sr.status = 'approved'
    group by sr.product_id, sr.variant_id
  ),
  ranked as (
    -- Running total in picking order, so each batch knows how much of the
    -- item's stock sits in front of it.
    select
      sp.id,
      sp.product_id,
      sp.variant_id,
      sp.expiry_date,
      sp.remaining_qty,
      sp.unit_cost,
      coalesce(
        sum(sp.remaining_qty) over (
          partition by sp.product_id, sp.variant_id
          order by sp.expiry_date asc nulls last, sp.created_at asc
          rows between unbounded preceding and 1 preceding
        ), 0
      ) as qty_before,
      row_number() over (
        partition by sp.product_id, sp.variant_id
        order by sp.expiry_date desc nulls first, sp.created_at desc
      ) = 1 as is_last
    from public.stock_purchases sp
    where sp.store_id = p_warehouse_id
      and sp.remaining_qty > 0
  ),
  allocated as (
    select
      r.*,
      coalesce(c.qty, 0) as total_committed,
      -- How much of the commitment reaches this batch: whatever is left
      -- after the batches ahead of it have taken their share, capped at
      -- what this batch holds.
      least(
        greatest(coalesce(c.qty, 0) - r.qty_before, 0),
        r.remaining_qty
      ) as batch_committed
    from ranked r
    left join committed_qty c
      on c.product_id = r.product_id
     and c.variant_id is not distinct from r.variant_id
  )
  select
    a.product_id,
    a.variant_id,
    case
      when pv.variant_name is not null then p.name || ' (' || pv.variant_name || ')'
      else p.name
    end,
    coalesce(pv.sku, p.sku),
    p_warehouse_id,
    a.id,
    a.expiry_date,
    a.remaining_qty,
    -- The last batch also carries any commitment the batches could not
    -- absorb, so an over-promise stays visible instead of vanishing.
    case
      when a.is_last then a.batch_committed
                          + greatest(a.total_committed - a.qty_before - a.remaining_qty, 0)
      else a.batch_committed
    end,
    a.remaining_qty - (
      case
        when a.is_last then a.batch_committed
                            + greatest(a.total_committed - a.qty_before - a.remaining_qty, 0)
        else a.batch_committed
      end
    ),
    case when v_show_cost then a.unit_cost else null end,
    case when v_show_cost then a.remaining_qty * coalesce(a.unit_cost, 0) else null end
  from allocated a
  join public.products p on p.id = a.product_id
  left join public.product_variants pv on pv.id = a.variant_id
  order by p.name, a.expiry_date asc nulls last;
end;
$$;

revoke all on function public.warehouse_stock_ledger(text) from public, anon;
grant execute on function public.warehouse_stock_ledger(text) to authenticated;
