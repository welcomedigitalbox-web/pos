-- ============================================
-- Discount approval tracking
-- ============================================
alter table sales add column if not exists discount_approved_by text;
alter table sales add column if not exists discount_approved_at timestamptz;
