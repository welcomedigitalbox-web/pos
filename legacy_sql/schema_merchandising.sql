-- ============================================
-- Merchandising: Product Categories + Variants (global catalog additions)
-- ============================================
create table if not exists product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz default now()
);
alter table product_categories enable row level security;
create policy "authenticated read/write - product_categories" on product_categories
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table products add column if not exists category_id uuid references product_categories(id);

create table if not exists product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  variant_name text not null,
  sku text,
  price_override numeric,
  created_at timestamptz default now()
);
create index idx_product_variants_product on product_variants(product_id);
alter table product_variants enable row level security;
create policy "authenticated read/write - product_variants" on product_variants
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Give every existing non-admin user access to the new AI Agent + Profile pages
-- (admin already bypasses all permission checks)
update profiles
set permissions = (
  select jsonb_agg(distinct elem)
  from jsonb_array_elements(permissions || '["ai-agent","profile"]'::jsonb) as elem
)
where role != 'admin';
