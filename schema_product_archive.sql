-- ============================================
-- Product Archive (soft-delete) — products with sale history can't be
-- hard-deleted (foreign key), so allow deactivating instead.
-- ============================================
alter table products add column if not exists is_active boolean not null default true;
