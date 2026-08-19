-- ============================================
-- A short or damaged delivery is a loss, so it needs evidence and a manager's
-- sign-off rather than a cashier's word alone.
-- ============================================
alter table stock_transfers add column if not exists photo_url text;
alter table stock_transfers add column if not exists discrepancy_approved_by text;

insert into storage.buckets (id, name, public)
values ('transfer-photos', 'transfer-photos', false)
on conflict (id) do nothing;

drop policy if exists "authenticated upload - transfer photos" on storage.objects;
create policy "authenticated upload - transfer photos" on storage.objects
  for insert with check (bucket_id = 'transfer-photos' and auth.role() = 'authenticated');

drop policy if exists "authenticated read - transfer photos" on storage.objects;
create policy "authenticated read - transfer photos" on storage.objects
  for select using (bucket_id = 'transfer-photos' and auth.role() = 'authenticated');
