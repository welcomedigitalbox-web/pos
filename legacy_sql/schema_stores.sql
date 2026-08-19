-- ============================================
-- Dynamic stores (replace hardcoded store list)
-- ============================================
create table if not exists stores (
  id text primary key,
  name text not null,
  created_at timestamptz default now()
);

alter table stores enable row level security;
create policy "authenticated read/write - stores" on stores
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Seed the 4 existing stores so nothing breaks
insert into stores (id, name) values
  ('SR-BAK', 'SR-BAK'),
  ('SR-MDY', 'SR-MDY'),
  ('SR-NOKL', 'SR-NOKL'),
  ('SR-WZYD', 'SR-WZYD')
on conflict (id) do nothing;
