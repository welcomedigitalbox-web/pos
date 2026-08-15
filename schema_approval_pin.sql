-- ============================================
-- Quick-approval PIN (Sale Manager/Owner/Admin set their own)
-- ============================================
alter table profiles add column if not exists approval_pin text;
