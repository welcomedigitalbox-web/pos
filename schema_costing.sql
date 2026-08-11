-- ============================================
-- Costing / COGS (Moving Weighted Average) setup
-- schema.sql + schema_auth.sql run ပြီးမှ ဒါကို run ပါ
-- ============================================

-- 1. Products table ထဲ cost tracking column ထပ်ထည့်
alter table products add column if not exists avg_cost numeric not null default 0;
alter table products add column if not exists last_purchase_cost numeric not null default 0;

-- 2. Stock purchases table (purchase receipt တစ်ခုစီ, moving average ကို ဒီကနေ recalc)
create table stock_purchases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) not null,
  store_id text not null,
  supplier text,
  qty numeric not null,
  unit_cost numeric not null,
  total_cost numeric not null,
  new_avg_cost numeric not null, -- purchase ဒီခု ဝင်ပြီးနောက် ရလာတဲ့ avg cost (audit trail)
  created_at timestamptz default now()
);

create index idx_stock_purchases_product on stock_purchases(product_id);
create index idx_stock_purchases_store on stock_purchases(store_id, created_at);

alter table stock_purchases enable row level security;
create policy "authenticated read/write - stock_purchases" on stock_purchases
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- 3. Sale items table ထဲ COGS snapshot ထည့် (sale ဖြစ်တဲ့ချိန်ရဲ့ cost ကို history အနေနဲ့ သိမ်း)
alter table sale_items add column if not exists unit_cost numeric not null default 0;
alter table sale_items add column if not exists line_cogs numeric not null default 0;

-- ============================================
-- Note: Moving average ကို app code ထဲက (stock-in form submit လုပ်တဲ့အခါ) တွက်ပါတယ်
-- Formula: new_avg_cost = (stock_qty * avg_cost + purchase_qty * unit_cost) / (stock_qty + purchase_qty)
-- ============================================
