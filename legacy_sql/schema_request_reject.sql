-- ============================================
-- A rejected stock request must say why, so the store knows what to do next.
-- ============================================
alter table stock_requests add column if not exists rejected_reason text;
