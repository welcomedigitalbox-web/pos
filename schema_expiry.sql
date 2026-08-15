-- ============================================
-- Expiry / Batch tracking setup
-- ============================================

-- Each stock_purchases row IS a batch. Add expiry + remaining balance for FEFO.
alter table stock_purchases add column if not exists expiry_date date;
alter table stock_purchases add column if not exists remaining_qty numeric not null default 0;

-- Backfill: for existing rows, assume full remaining (best-effort; won't be perfectly accurate
-- for old sales that already consumed stock, but gives a starting point going forward)
update stock_purchases set remaining_qty = qty where remaining_qty = 0;

create index idx_stock_purchases_fefo on stock_purchases(product_id, expiry_date, created_at);

-- Link sale_items to which batch they were fulfilled from (for accurate ledger/COGS trace)
alter table sale_items add column if not exists batch_id uuid references stock_purchases(id);
