-- ============================================
-- Stock Request (order stock -> receive -> mismatch approval)
-- ============================================
create table if not exists stock_requests (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  product_id uuid references products(id) not null,
  requested_qty numeric not null,
  received_qty numeric,
  note text,
  status text not null default 'pending'
    check (status in ('pending','received','mismatch','approved','rejected')),
  requested_by text,
  received_by text,
  approved_by text,
  created_at timestamptz default now(),
  received_at timestamptz,
  approved_at timestamptz
);

create index idx_stock_requests_store on stock_requests(store_id, status);
alter table stock_requests enable row level security;
create policy "authenticated read/write - stock_requests" on stock_requests
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Link the stock-in batch created when a request is received (for traceability)
alter table stock_purchases add column if not exists stock_request_id uuid references stock_requests(id);

-- ============================================
-- Damage tracking
-- ============================================
create table if not exists stock_damages (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  product_id uuid references products(id) not null,
  qty numeric not null,
  reason text,
  reported_by text,
  created_at timestamptz default now()
);

create index idx_stock_damages_store on stock_damages(store_id, created_at);
alter table stock_damages enable row level security;
create policy "authenticated read/write - stock_damages" on stock_damages
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
