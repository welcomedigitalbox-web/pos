-- ============================================
-- Amazon-style Parent/Child variation model
--   products         = Parent listing (or standalone single-SKU product)
--   product_variants = Child SKUs (own SKU / price / stock)
--   store_inventory  = stock per (store, product, variant)
--                      variant_id NULL = the product itself has no variations
-- ============================================

-- Variation theme on the parent (e.g. 'Size', 'Color', 'Size-Color')
alter table products add column if not exists variation_theme text;

-- Children get their own price (null = inherit parent price) and can be deactivated
alter table product_variants add column if not exists is_active boolean not null default true;

-- ---- store_inventory becomes variant-aware ----
alter table store_inventory add column if not exists variant_id uuid references product_variants(id) on delete cascade;

-- Replace the old (store_id, product_id) uniqueness with one that includes variant.
-- COALESCE is used because Postgres treats NULLs as distinct in unique constraints,
-- which would otherwise allow duplicate rows for variant_id = NULL.
alter table store_inventory drop constraint if exists store_inventory_store_id_product_id_key;
drop index if exists store_inventory_store_product_variant_uniq;
create unique index store_inventory_store_product_variant_uniq
  on store_inventory (
    store_id,
    product_id,
    (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

create index if not exists idx_store_inventory_variant on store_inventory(variant_id);

-- ---- Other stock-movement tables become variant-aware ----
alter table stock_purchases add column if not exists variant_id uuid references product_variants(id) on delete cascade;
alter table stock_damages   add column if not exists variant_id uuid references product_variants(id) on delete cascade;
alter table stock_requests  add column if not exists variant_id uuid references product_variants(id) on delete cascade;
alter table stock_transfers add column if not exists variant_id uuid references product_variants(id) on delete cascade;
alter table sale_items      add column if not exists variant_id uuid references product_variants(id) on delete set null;
