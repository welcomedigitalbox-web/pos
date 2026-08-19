-- ============================================
-- A PO is a financial commitment to a supplier, so it needs sign-off before
-- goods can be received against it.
--   draft → (manager approves) → ordered → partial/received
-- ============================================
alter table purchase_orders add column if not exists approved_by text;
alter table purchase_orders add column if not exists approved_at timestamptz;
