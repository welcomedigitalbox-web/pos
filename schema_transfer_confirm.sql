-- ============================================
-- Stock transfers become a two-step flow:
--   1. Warehouse sends  -> deducted from central, status 'in_transit'
--   2. Store confirms   -> actual received qty added to the store
--      If actual != sent, the difference is recorded as a discrepancy
--      so it can be investigated instead of silently disappearing.
-- ============================================

alter table stock_transfers add column if not exists status text not null default 'received'
  check (status in ('in_transit','received','discrepancy'));
alter table stock_transfers add column if not exists received_qty numeric;
alter table stock_transfers add column if not exists received_by text;
alter table stock_transfers add column if not exists received_at timestamptz;
alter table stock_transfers add column if not exists discrepancy_note text;

-- Existing transfers were added to the destination store immediately,
-- so treat them as already fully received.
update stock_transfers
set status = 'received', received_qty = qty, received_at = created_at
where received_qty is null;

create index if not exists idx_stock_transfers_status on stock_transfers(to_store_id, status);
