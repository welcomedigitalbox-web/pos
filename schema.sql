-- ============================================
-- POS MVP Schema
-- Supabase SQL Editor မှာ ဒီ script ကို run ပါ
-- ============================================

-- 1. Products table
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  price numeric not null default 0,
  stock_qty numeric not null default 0,
  store_id text not null default 'default',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Sales table (each checkout = one sale)
create table sales (
  id uuid primary key default gen_random_uuid(),
  sale_ref text, -- ဥပမာ POS receipt number
  store_id text not null default 'default',
  cashier text,
  total numeric not null default 0,
  created_at timestamptz default now()
);

-- 3. Sale items table (line items per sale)
create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references sales(id) on delete cascade,
  product_id uuid references products(id),
  product_name text not null, -- snapshot (product ပြင်လာလည်း history မပျက်အောင်)
  qty numeric not null,
  unit_price numeric not null,
  line_total numeric not null,
  created_at timestamptz default now()
);

-- Index for fast query (dashboard/report အတွက် အရေးကြီး)
create index idx_products_store on products(store_id);
create index idx_sales_store_date on sales(store_id, created_at);
create index idx_sale_items_sale on sale_items(sale_id);

-- ============================================
-- Row Level Security (MVP stage: open access)
-- Production အတွက် login/role အလိုက် ချရမယ်, MVP အတွက် ခဏ open
-- ============================================
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;

create policy "public access - products" on products for all using (true) with check (true);
create policy "public access - sales" on sales for all using (true) with check (true);
create policy "public access - sale_items" on sale_items for all using (true) with check (true);

-- ============================================
-- Sample product data (test အတွက်) - ဖျက်ချင်ရင် ဒီအပိုင်း run မလုပ်ပါနဲ့
-- ============================================
insert into products (name, sku, price, stock_qty, store_id) values
('Baby Diaper (M)', 'SKU-001', 18500, 50, 'SR-BAK'),
('Baby Powder', 'SKU-002', 8500, 30, 'SR-BAK'),
('Feeding Bottle', 'SKU-003', 15000, 20, 'SR-BAK'),
('Baby Wipes', 'SKU-004', 4500, 100, 'SR-BAK'),
('Baby Shampoo', 'SKU-005', 12000, 25, 'SR-BAK');
