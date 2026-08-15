-- ============================================
-- Dynamic Loyalty Tiers (Sale Manager/Owner/Admin can create custom tiers)
-- ============================================
create table if not exists loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  name text not null,
  discount_percent numeric not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz default now()
);
create index idx_loyalty_tiers_store on loyalty_tiers(store_id);
alter table loyalty_tiers enable row level security;
create policy "authenticated read/write - loyalty_tiers" on loyalty_tiers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Seed default Silver/Gold tiers for each existing store
insert into loyalty_tiers (store_id, name, discount_percent, sort_order)
select s.id, m.name, m.discount_percent, m.sort_order
from stores s
cross join (values
  ('Silver', 3, 1),
  ('Gold', 5, 2)
) as m(name, discount_percent, sort_order);

-- Add new FK column on customers (nullable = no tier)
alter table customers add column if not exists loyalty_tier_id uuid references loyalty_tiers(id);

-- Best-effort migrate old text-based tier values to the new tier records
update customers c
set loyalty_tier_id = lt.id
from loyalty_tiers lt
where lt.store_id = c.store_id
  and lower(lt.name) = c.loyalty_tier
  and c.loyalty_tier in ('silver','gold');

-- Drop the old hardcoded column
alter table customers drop column if exists loyalty_tier;
