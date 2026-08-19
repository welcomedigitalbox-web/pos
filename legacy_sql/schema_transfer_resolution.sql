-- ============================================
-- A shortage is not automatically a loss. The warehouse decides which it was:
--   'miscount'  — the goods never left, so they go back on the warehouse shelf
--   'damaged'   — genuinely lost or broken, so it is written off as damage
-- Either way the missing quantity is restored first, because the warehouse was
-- already debited the full amount when it shipped.
-- ============================================
alter table stock_transfers drop constraint if exists stock_transfers_status_check;
alter table stock_transfers add constraint stock_transfers_status_check
  check (status in ('in_transit','received','discrepancy','pending_approval','resolved'));

alter table stock_transfers add column if not exists resolution text
  check (resolution is null or resolution in ('miscount','damaged'));
alter table stock_transfers add column if not exists resolved_by text;
alter table stock_transfers add column if not exists resolved_at timestamptz;
alter table stock_transfers add column if not exists resolution_note text;
