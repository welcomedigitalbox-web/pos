-- ============================================
-- Sale Returns
--   * Per item: condition decides whether stock becomes sellable again
--   * Refund: cash / exchange / store credit
--   * Always needs a Sale Manager to approve before anything moves
-- ============================================

create table if not exists sale_returns (
  id uuid primary key default gen_random_uuid(),
  return_number text not null,
  original_sale_id uuid references sales(id),
  store_id text not null,
  customer_id uuid references customers(id),
  customer_name text,
  refund_method text not null default 'cash'
    check (refund_method in ('cash','exchange','store_credit')),
  refund_amount numeric not null default 0,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reason text,
  voucher_url text,
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  rejected_reason text,
  created_at timestamptz default now()
);
create index if not exists idx_sale_returns_sale on sale_returns(original_sale_id);
create index if not exists idx_sale_returns_store on sale_returns(store_id, created_at desc);
alter table sale_returns enable row level security;
drop policy if exists "authenticated read/write - sale_returns" on sale_returns;
create policy "authenticated read/write - sale_returns" on sale_returns
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create table if not exists sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references sale_returns(id) on delete cascade,
  product_id uuid not null references products(id),
  variant_id uuid references product_variants(id),
  product_name text,
  qty numeric not null,
  -- Net of the original order's discount, so refunds match what was actually paid
  unit_price numeric not null default 0,
  unit_cogs numeric not null default 0,
  -- 'good' goes back on the shelf; 'damaged' is written off instead
  condition text not null default 'good' check (condition in ('good','damaged')),
  created_at timestamptz default now()
);
create index if not exists idx_sale_return_items_return on sale_return_items(return_id);
alter table sale_return_items enable row level security;
drop policy if exists "authenticated read/write - sale_return_items" on sale_return_items;
create policy "authenticated read/write - sale_return_items" on sale_return_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Store credit balance, used when a refund is issued as credit
alter table customers add column if not exists store_credit numeric not null default 0;

-- Private bucket for return vouchers; access is via short-lived signed URLs only
insert into storage.buckets (id, name, public)
values ('return-vouchers', 'return-vouchers', false)
on conflict (id) do nothing;

drop policy if exists "authenticated upload - return vouchers" on storage.objects;
create policy "authenticated upload - return vouchers" on storage.objects
  for insert with check (bucket_id = 'return-vouchers' and auth.role() = 'authenticated');

drop policy if exists "authenticated read - return vouchers" on storage.objects;
create policy "authenticated read - return vouchers" on storage.objects
  for select using (bucket_id = 'return-vouchers' and auth.role() = 'authenticated');
