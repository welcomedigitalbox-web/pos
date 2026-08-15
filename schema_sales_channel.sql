-- ============================================
-- Sale Channel (Facebook/TikTok/Viber/Other) for online orders
-- ============================================
alter table sales add column if not exists channel text;
