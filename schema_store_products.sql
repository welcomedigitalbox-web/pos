-- ============================================
-- Not every store sells every product. A row here marks a product as switched
-- off for a store; absence means available, so nothing needs backfilling.
-- ============================================
create table if not exists store_product_settings (
  store_id text not null,
  product_id uuid not null references products(id) on delete cascade,
  is_available boolean not null default true,
  updated_by text,
  updated_at timestamptz default now(),
  primary key (store_id, product_id)
);
create index if not exists idx_store_product_settings_store on store_product_settings(store_id);
alter table store_product_settings enable row level security;
drop policy if exists "authenticated read/write - store_product_settings" on store_product_settings;
create policy "authenticated read/write - store_product_settings" on store_product_settings
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
