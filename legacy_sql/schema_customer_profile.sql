-- ============================================
-- Customer profile detail fields
-- ============================================
alter table customers add column if not exists email text;
alter table customers add column if not exists date_of_birth date;
alter table customers add column if not exists delivery_address text;
alter table customers add column if not exists facebook text;
alter table customers add column if not exists tiktok text;
