-- =====================================================================
-- A shop may read the ledger of the warehouse that supplies it
-- Repo path: supabase/migrations/20260906000007_ledger_for_supplied_shops.sql
--
-- The point of the report is that a branch checks what is free before it
-- asks. It could not: the function tested can_read_store, and a shop has
-- no read on warehouse rows - correctly, since one branch has no business
-- in another's books.
--
-- Reading the ledger is a narrower thing than reading the table. It says
-- how much of a product is on the shelf and how much is already promised,
-- for the one warehouse that supplies this shop, and it says nothing about
-- cost. So the check widens to include shops the warehouse supplies, and
-- the cost columns stay closed to anyone below a department head.
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
  on_hand         numeric,
  committed       numeric,
  free            numeric,
  unit_cost       numeric,
  stock_value     numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_show_cost boolean;
  v_supplies  boolean;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  -- Either you can read the warehouse outright, or it is the warehouse
  -- that fills your branch's requests.
  select exists (
    select 1 from public.stores s
    where s.supply_warehouse_id = p_warehouse_id
      and public.covers_store(s.id)
  ) into v_supplies;

  if not (public.can_read_store(p_warehouse_id) or v_supplies) then
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
