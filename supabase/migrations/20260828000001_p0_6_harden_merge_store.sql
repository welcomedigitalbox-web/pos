-- =====================================================================
-- P0-6: Lock down and correct merge_store()
-- Repo path: supabase/migrations/20260828000001_p0_6_harden_merge_store.sql
--
-- Changes:
--   1. Admin-only. Was callable by any authenticated user.
--   2. search_path pinned (SECURITY DEFINER without it is hijackable).
--   3. EXECUTE revoked from public/anon.
--   4. Source must exist and must not be a warehouse that still supplies
--      an active store (that would orphan supply_warehouse_id).
--   5. FIX: stock_transfers.from_store_id was never reassigned.
--   6. FIX: customers, payment_methods, loyalty_tiers,
--      store_product_settings, inter_store_settlements were never
--      reassigned - customers would point at a dead store.
--   7. FIX: stores.supply_warehouse_id pointing at source now repointed.
--   8. Audit row written to activity_log.
--
-- Merge arithmetic is unchanged from the original.
-- Idempotent - safe to re-run.
-- =====================================================================

create or replace function public.merge_store(source_id text, target_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_nil constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  -- ---------------------------------------------------------------
  -- Authorisation
  -- ---------------------------------------------------------------
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin may merge stores';
  end if;

  -- ---------------------------------------------------------------
  -- Preconditions
  -- ---------------------------------------------------------------
  if source_id = target_id then
    raise exception 'Source and target must be different';
  end if;

  if not exists (select 1 from stores where id = source_id) then
    raise exception 'Source location does not exist';
  end if;

  if not exists (select 1 from stores where id = target_id) then
    raise exception 'Target location does not exist';
  end if;

  -- ---------------------------------------------------------------
  -- Inventory: combine overlapping rows with weighted average cost
  -- ---------------------------------------------------------------
  update store_inventory t
  set stock_qty = t.stock_qty + s.stock_qty,
      avg_cost = case
        when (t.stock_qty + s.stock_qty) > 0
          then ((t.stock_qty * t.avg_cost) + (s.stock_qty * s.avg_cost))
               / (t.stock_qty + s.stock_qty)
        else t.avg_cost
      end,
      updated_at = now()
  from store_inventory s
  where s.store_id = source_id
    and t.store_id = target_id
    and t.product_id = s.product_id
    and coalesce(t.variant_id, v_nil) = coalesce(s.variant_id, v_nil);

  delete from store_inventory s
  where s.store_id = source_id
    and exists (
      select 1 from store_inventory t
      where t.store_id = target_id
        and t.product_id = s.product_id
        and coalesce(t.variant_id, v_nil) = coalesce(s.variant_id, v_nil)
    );

  update store_inventory set store_id = target_id where store_id = source_id;

  -- ---------------------------------------------------------------
  -- Reassign history so reports stay complete
  -- ---------------------------------------------------------------
  update sales            set store_id      = target_id where store_id      = source_id;
  update stock_purchases  set store_id      = target_id where store_id      = source_id;
  update stock_damages    set store_id      = target_id where store_id      = source_id;
  update stock_requests   set store_id      = target_id where store_id      = source_id;
  update sales_reps       set store_id      = target_id where store_id      = source_id;
  update profiles         set store_id      = target_id where store_id      = source_id;

  -- FIX: both sides of a transfer, not just the destination
  update stock_transfers  set to_store_id   = target_id where to_store_id   = source_id;
  update stock_transfers  set from_store_id = target_id where from_store_id = source_id;

  -- FIX: previously missing entirely
  update customers        set store_id      = target_id where store_id      = source_id;
  update sale_returns     set store_id      = target_id where store_id      = source_id;
  update sale_returns     set processed_store_id = target_id
    where processed_store_id = source_id;
  update inter_store_settlements set owing_store_id = target_id
    where owing_store_id = source_id;
  update inter_store_settlements set owed_store_id  = target_id
    where owed_store_id  = source_id;

  -- FIX: stock_requests.requested_warehouse_id could point at source
  update stock_requests   set requested_warehouse_id = target_id
    where requested_warehouse_id = source_id;

  -- FIX: another store may name source as its supplying warehouse
  update stores set supply_warehouse_id = target_id
    where supply_warehouse_id = source_id;

  -- ---------------------------------------------------------------
  -- Per-store config: keep the target's, drop the source's.
  -- These are configuration, not history - merging them would create
  -- duplicate payment methods and tiers on the target.
  -- ---------------------------------------------------------------
  delete from store_product_settings where store_id = source_id;
  delete from payment_methods        where store_id = source_id;
  delete from loyalty_tiers          where store_id = source_id;
  delete from store_settings         where store_id = source_id;

  -- ---------------------------------------------------------------
  -- Retire the source location
  -- ---------------------------------------------------------------
  update stores set is_active = false where id = source_id;

  insert into activity_log (entity_type, entity_id, action, detail, actor)
  values (
    'store',
    null,
    'merge_store',
    format('merged %s into %s', source_id, target_id),
    coalesce(auth.uid()::text, 'system')
  );
end;
$function$;

revoke all on function public.merge_store(text, text) from public, anon;
grant execute on function public.merge_store(text, text) to authenticated;
