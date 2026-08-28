-- P0-2 (completion): operational and child-row policies.
-- 20260828000005 landed only its reference-tier policies, leaving 17 tables
-- on the old blanket "authenticated" ALL policy. This applies the remainder.
-- Depends on helpers from 20260828000004. Idempotent.

do $$
declare r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public' and policyname like 'authenticated read/write - %'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

do $$
declare
  t text;
  tables text[] := array[
    'sales','customers','store_inventory','stock_purchases','stock_damages',
    'stock_requests','sale_returns','cash_drawer_sessions'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read %s" on public.%I', t, t);
    execute format(
      'create policy "read %s" on public.%I for select to authenticated '
      'using (public.can_read_store(store_id))', t, t);
    execute format('drop policy if exists "write %s" on public.%I', t, t);
    execute format(
      'create policy "write %s" on public.%I for all to authenticated '
      'using (public.can_write_store(store_id)) '
      'with check (public.can_write_store(store_id))', t, t);
  end loop;
end $$;

alter table public.stock_transfers enable row level security;
drop policy if exists "read stock_transfers" on public.stock_transfers;
create policy "read stock_transfers" on public.stock_transfers for select to authenticated
  using (public.can_read_store(from_store_id) or public.can_read_store(to_store_id));
drop policy if exists "write stock_transfers" on public.stock_transfers;
create policy "write stock_transfers" on public.stock_transfers for all to authenticated
  using (public.can_write_store(from_store_id) or public.can_write_store(to_store_id))
  with check (public.can_write_store(from_store_id) or public.can_write_store(to_store_id));

alter table public.inter_store_settlements enable row level security;
drop policy if exists "read inter_store_settlements" on public.inter_store_settlements;
create policy "read inter_store_settlements" on public.inter_store_settlements for select to authenticated
  using (public.can_read_store(owing_store_id) or public.can_read_store(owed_store_id));
drop policy if exists "write inter_store_settlements" on public.inter_store_settlements;
create policy "write inter_store_settlements" on public.inter_store_settlements for all to authenticated
  using (public.can_write_store(owing_store_id) or public.can_write_store(owed_store_id))
  with check (public.can_write_store(owing_store_id) or public.can_write_store(owed_store_id));

alter table public.sale_items enable row level security;
drop policy if exists "read sale_items" on public.sale_items;
create policy "read sale_items" on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_items.sale_id and public.can_read_store(s.store_id)));
drop policy if exists "write sale_items" on public.sale_items;
create policy "write sale_items" on public.sale_items for all to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_items.sale_id and public.can_write_store(s.store_id)))
  with check (exists (select 1 from public.sales s
                      where s.id = sale_items.sale_id and public.can_write_store(s.store_id)));

alter table public.sale_return_items enable row level security;
drop policy if exists "read sale_return_items" on public.sale_return_items;
create policy "read sale_return_items" on public.sale_return_items for select to authenticated
  using (exists (select 1 from public.sale_returns r
                 where r.id = sale_return_items.return_id and public.can_read_store(r.store_id)));
drop policy if exists "write sale_return_items" on public.sale_return_items;
create policy "write sale_return_items" on public.sale_return_items for all to authenticated
  using (exists (select 1 from public.sale_returns r
                 where r.id = sale_return_items.return_id and public.can_write_store(r.store_id)))
  with check (exists (select 1 from public.sale_returns r
                      where r.id = sale_return_items.return_id and public.can_write_store(r.store_id)));

alter table public.cash_movements enable row level security;
drop policy if exists "read cash_movements" on public.cash_movements;
create policy "read cash_movements" on public.cash_movements for select to authenticated
  using (exists (select 1 from public.cash_drawer_sessions d
                 where d.id = cash_movements.session_id and public.can_read_store(d.store_id)));
drop policy if exists "write cash_movements" on public.cash_movements;
create policy "write cash_movements" on public.cash_movements for all to authenticated
  using (exists (select 1 from public.cash_drawer_sessions d
                 where d.id = cash_movements.session_id and public.can_write_store(d.store_id)))
  with check (exists (select 1 from public.cash_drawer_sessions d
                      where d.id = cash_movements.session_id and public.can_write_store(d.store_id)));

do $$
declare
  t text;
  tables text[] := array['purchase_orders','purchase_order_items','po_payments'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read %s" on public.%I', t, t);
    execute format(
      'create policy "read %s" on public.%I for select to authenticated '
      'using (public.is_global_reader())', t, t);
    execute format('drop policy if exists "write %s" on public.%I', t, t);
    execute format(
      'create policy "write %s" on public.%I for all to authenticated '
      'using (public.is_global_writer()) with check (public.is_global_writer())', t, t);
  end loop;
end $$;

alter table public.suppliers enable row level security;
drop policy if exists "read suppliers" on public.suppliers;
create policy "read suppliers" on public.suppliers for select to authenticated
  using (public.is_global_reader());

create index if not exists idx_sales_store_created      on public.sales (store_id, created_at desc);
create index if not exists idx_sale_items_sale          on public.sale_items (sale_id);
create index if not exists idx_store_inventory_store    on public.store_inventory (store_id);
create index if not exists idx_stock_transfers_from     on public.stock_transfers (from_store_id);
create index if not exists idx_stock_transfers_to       on public.stock_transfers (to_store_id);
create index if not exists idx_sale_returns_store       on public.sale_returns (store_id);
create index if not exists idx_sale_return_items_return on public.sale_return_items (return_id);
create index if not exists idx_cash_movements_session   on public.cash_movements (session_id);
create index if not exists idx_customers_store          on public.customers (store_id);
create index if not exists idx_stock_requests_store     on public.stock_requests (store_id);
