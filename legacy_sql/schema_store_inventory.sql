-- ============================================
-- Products become a GLOBAL catalog (name/SKU/price shared across stores).
-- Stock quantity + cost move into a new per-store `store_inventory` table.
-- ============================================

create table if not exists store_inventory (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  product_id uuid not null references products(id) on delete cascade,
  stock_qty numeric not null default 0,
  avg_cost numeric not null default 0,
  previous_avg_cost numeric not null default 0,
  last_purchase_cost numeric not null default 0,
  updated_at timestamptz default now(),
  unique (store_id, product_id)
);
create index idx_store_inventory_store on store_inventory(store_id);
create index idx_store_inventory_product on store_inventory(product_id);
alter table store_inventory enable row level security;
create policy "authenticated read/write - store_inventory" on store_inventory
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Migrate each existing product's stock/cost into store_inventory for its current store
insert into store_inventory (store_id, product_id, stock_qty, avg_cost, previous_avg_cost, last_purchase_cost, updated_at)
select store_id, id, stock_qty, avg_cost, previous_avg_cost, last_purchase_cost, coalesce(updated_at, now())
from products
on conflict (store_id, product_id) do nothing;

-- Drop the now-relocated per-store columns from the products catalog
alter table products drop column if exists stock_qty;
alter table products drop column if exists avg_cost;
alter table products drop column if exists previous_avg_cost;
alter table products drop column if exists last_purchase_cost;
-- products.store_id remains only as "originally added in" metadata — no longer used to filter visibility
