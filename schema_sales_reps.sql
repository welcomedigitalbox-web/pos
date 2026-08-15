-- ============================================
-- Sales Reps (floor salesmen — not necessarily login accounts)
-- ============================================
create table if not exists sales_reps (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz default now()
);
create index idx_sales_reps_store on sales_reps(store_id);
alter table sales_reps enable row level security;
create policy "authenticated read/write - sales_reps" on sales_reps
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table sales add column if not exists sale_rep_id uuid references sales_reps(id);
alter table sales add column if not exists sale_rep_name text;
