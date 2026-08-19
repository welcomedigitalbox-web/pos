-- ============================================
-- Activity log — an append-only audit trail of who did what.
-- Generic on purpose so any module (PO, stock, sales) can write to it.
-- ============================================
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,      -- e.g. 'purchase_order'
  entity_id uuid,                 -- the record the action applies to
  action text not null,           -- e.g. 'created', 'received', 'cancelled'
  detail text,                    -- human-readable summary
  actor text,                     -- email of the user who did it
  created_at timestamptz default now()
);
create index if not exists idx_activity_log_entity on activity_log(entity_type, entity_id, created_at desc);
alter table activity_log enable row level security;

drop policy if exists "authenticated read - activity_log" on activity_log;
create policy "authenticated read - activity_log" on activity_log
  for select using (auth.role() = 'authenticated');

-- Insert-only for authenticated users: the log must not be editable or deletable,
-- otherwise it can't be trusted as an audit trail.
drop policy if exists "authenticated insert - activity_log" on activity_log;
create policy "authenticated insert - activity_log" on activity_log
  for insert with check (auth.role() = 'authenticated');
