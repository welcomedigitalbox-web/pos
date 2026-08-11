-- ============================================
-- Costing / COGS (Moving Weighted Average) setup
-- schema.sql + schema_auth.sql run ပြီးမှ ဒါကို run ပါ
-- ============================================

alter table products add column if not exists avg_cost numeric not null default 0;
alter table products add column if not exists last_purchase_cost numeric not null default 0;

create table stock_purchases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) not null,
  store_id text not null,
  supplier text,
  qty numeric not null,
  unit_cost numeric not null,
  total_cost numeric not null,
  new_avg_cost numeric not null,
  created_at timestamptz default now()
);

create index idx_stock_purchases_product on stock_purchases(product_id);
create index idx_stock_purchases_store on stock_purchases(store_id, created_at);

alter table stock_purchases enable row level security;
create policy "authenticated read/write - stock_purchases" on stock_purchases
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table sale_items add column if not exists unit_cost numeric not null default 0;
alter table sale_items add column if not exists line_cogs numeric not null default 0;
