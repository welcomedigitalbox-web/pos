-- ============================================
-- Locations must stay changeable:
--   * archive instead of delete (history is never orphaned)
--   * merge one location into another when the business consolidates
--   * optional region so Showroom / Online in the same city can be grouped
-- ============================================

alter table stores add column if not exists is_active boolean not null default true;
alter table stores add column if not exists region text;

-- Merge moves every trace of `source` onto `target`, combining stock with a
-- weighted-average cost so inventory value is preserved, then archives source.
create or replace function merge_store(source_id text, target_id text)
returns void
language plpgsql
security definer
as $$
begin
  if source_id = target_id then
    raise exception 'Source and target must be different';
  end if;
  if not exists (select 1 from stores where id = target_id) then
    raise exception 'Target location does not exist';
  end if;

  -- Combine inventory rows that exist in both locations
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
    and coalesce(t.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(s.variant_id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- Rows that only exist in the source simply move across
  delete from store_inventory s
  where s.store_id = source_id
    and exists (
      select 1 from store_inventory t
      where t.store_id = target_id
        and t.product_id = s.product_id
        and coalesce(t.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(s.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );
  update store_inventory set store_id = target_id where store_id = source_id;

  -- Reassign history so reports stay complete
  update sales            set store_id    = target_id where store_id    = source_id;
  update stock_purchases  set store_id    = target_id where store_id    = source_id;
  update stock_damages    set store_id    = target_id where store_id    = source_id;
  update stock_requests   set store_id    = target_id where store_id    = source_id;
  update stock_transfers  set to_store_id = target_id where to_store_id = source_id;
  update sales_reps       set store_id    = target_id where store_id    = source_id;
  update profiles         set store_id    = target_id where store_id    = source_id;

  -- Settings and payment methods: keep the target's, drop the source's
  delete from store_settings where store_id = source_id;

  update stores set is_active = false where id = source_id;
end;
$$;
