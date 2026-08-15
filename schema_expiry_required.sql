-- ============================================
-- 1. Per-product "expiry required" flag
--    (only perishables should force an expiry date at receiving time)
-- 2. Track who received each batch and when
-- ============================================

alter table products add column if not exists requires_expiry boolean not null default false;

alter table stock_purchases add column if not exists received_by text;
alter table stock_purchases add column if not exists received_at timestamptz default now();

-- Backfill received_at for existing batches so history stays consistent
update stock_purchases set received_at = created_at where received_at is null;
