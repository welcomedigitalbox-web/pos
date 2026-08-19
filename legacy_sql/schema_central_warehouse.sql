-- ============================================
-- Central Warehouse model: Stock-In goes to one central pool;
-- Warehouse department distributes (transfers) stock out to specific stores.
-- ============================================

alter table stores add column if not exists is_warehouse boolean not null default false;

-- Create the single Central Warehouse virtual "store" (id fixed so code can reference it)
insert into stores (id, name, is_warehouse)
values ('CENTRAL-WH', 'Central Warehouse', true)
on conflict (id) do update set is_warehouse = true;

-- Track stock transfers from the central warehouse to a specific store
create table if not exists stock_transfers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  to_store_id text not null,
  qty numeric not null,
  transferred_by text,
  note text,
  created_at timestamptz default now()
);
create index idx_stock_transfers_store on stock_transfers(to_store_id);
alter table stock_transfers enable row level security;
create policy "authenticated read/write - stock_transfers" on stock_transfers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
