-- ============================================
-- Customers + cashier tracking setup
-- ============================================

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  store_id text not null,
  created_at timestamptz default now()
);

create index idx_customers_store on customers(store_id);

alter table customers enable row level security;
create policy "authenticated read/write - customers" on customers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Link sales to a customer (optional) and store the cashier's user id
alter table sales add column if not exists customer_id uuid references customers(id);
alter table sales add column if not exists customer_name text;
alter table sales add column if not exists cashier_email text;
