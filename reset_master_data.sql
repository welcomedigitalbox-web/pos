-- ============================================================
-- FULL RESET — products, categories, stores and warehouses
--
-- Run reset_test_data.sql FIRST. Transactions reference products and
-- stores, so they must be gone before this will succeed.
--
-- ⚠️ CANNOT BE UNDONE. Take a Supabase backup first.
-- ============================================================

begin;

-- Store-scoped settings and staff lists
delete from sales_reps;
delete from store_settings;

-- Payment methods are global now, but clear any left tied to a store
delete from payment_methods where store_id is not null;

-- Products and their stock rows
delete from product_variants;
delete from store_inventory;
delete from products;
delete from product_categories;

-- User accounts survive, but their store link must be cleared or the
-- delete below is blocked and staff end up pointing at a store that is gone
update profiles set store_id = null;

-- stores.supply_warehouse_id points at stores, so break those links first
update stores set supply_warehouse_id = null;
delete from stores;

commit;

-- ---- Verify: all zero ----
select
  (select count(*) from products)           as products,
  (select count(*) from product_variants)   as variants,
  (select count(*) from product_categories) as categories,
  (select count(*) from stores)             as stores,
  (select count(*) from store_inventory)    as inventory_rows,
  (select count(*) from sales_reps)         as sales_reps;
