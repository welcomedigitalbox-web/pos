-- ============================================
-- With multiple warehouses, a transfer needs to record where it came FROM,
-- not just where it went.
-- ============================================
alter table stock_transfers add column if not exists from_store_id text;

-- Existing transfers all originated from the single central warehouse
update stock_transfers set from_store_id = 'CENTRAL-WH' where from_store_id is null;

create index if not exists idx_stock_transfers_from on stock_transfers(from_store_id);
