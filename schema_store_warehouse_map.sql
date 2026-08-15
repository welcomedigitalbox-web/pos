-- ============================================
-- Each store is supplied by one warehouse.
--   * Transfer screens only offer the stores a warehouse actually serves
--   * Reorder suggestions use only those stores' demand, not every store's
-- Nullable on purpose: unassigned stores stay visible so nothing is stranded.
-- ============================================
alter table stores add column if not exists supply_warehouse_id text references stores(id);

create index if not exists idx_stores_supply_wh on stores(supply_warehouse_id);
