-- ============================================
-- Customer Loyalty Tier (auto-discount)
-- ============================================
alter table customers add column if not exists loyalty_tier text not null default 'none'
  check (loyalty_tier in ('none','silver','gold'));
