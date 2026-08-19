-- ============================================
-- Stock requests now need a manager to sign off before the warehouse sees them,
-- so a cashier can't pull stock on their own.
--   awaiting_approval → manager approves → pending → warehouse fulfils
-- ============================================
alter table stock_requests drop constraint if exists stock_requests_status_check;
alter table stock_requests add constraint stock_requests_status_check
  check (status in ('awaiting_approval','pending','received','mismatch','approved','rejected'));

alter table stock_requests add column if not exists requested_warehouse_id text;
