-- =====================================================================
-- P0-2: Replace blanket auth.role() = 'authenticated' policies
-- Repo path: supabase/migrations/20260828000005_p0_2_rls_store_scoping.sql
--
-- Before: 26 tables carried a single ALL policy whose only test was that
-- the caller was logged in. Any cashier could read every store's sales,
-- costs, suppliers and customer phone numbers, and could edit or delete
-- any of them through the REST API.
--
-- After, three tiers:
--
--   Reference / configuration  - readable by all signed-in staff,
--     writable only by admin. Products, stores, suppliers, categories,
--     payment methods, loyalty tiers, store settings.
--
--   Operational, store-scoped  - visible per can_read_store(),
--     writable per can_write_store(). Sales, inventory, transfers,
--     returns, cash drawer, settlements.
--
--   Child rows                 - scoped through their parent, so a sale
--     line is visible exactly when its sale is.
--
-- RUN THIS ON A LOCAL RESET FIRST (supabase db reset). A mistake here
-- does not corrupt data, but it can stop staff working.
--
-- Idempotent - safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Drop the blanket policies. Named exactly as they exist today.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'cash_drawer_sessions','cash_movements','customers','inter_store_settlements',
    'loyalty_tiers','payment_methods','po_payments','product_categories',
    'product_variants','products','purchase_order_items','purchase_orders',
    'sale_items','sale_return_items','sale_returns','sales','sales_reps',
    'stock_damages','stock_purchases','stock_requests','stock_transfers',
    'store_inventory','store_product_settings','store_settings','stores','suppliers'
  ];
begin
  foreach t in array tables loop
    execute format(
      'drop policy if exists %I on public.%I',
      'authenticated read/write - ' || t, t
    );
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- =====================================================================
-- TIER 1 - Reference and configuration.
-- Everyone signed in reads; only admin writes.
-- =====================================================================
do $$
declare
  t text;
  tables text[] := array[
    'products','product_variants','product_categories','stores','suppliers',
    'loyalty_tiers','payment_methods','store_settings','store_product_settings',
    'sales_reps'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists "read %s" on public.%I', t, t);
    execute format(
      'create policy "read %s" on public.%I for select to authenticated using (true)',
      t, t
    );

    execute format('drop policy if exists "admin write %s" on public.%I', t, t);
    execute format(
      'create policy "admin write %s" on public.%I for all to authenticated '
      'using (public.is_admin()) with check (public.is_admin())',
      t, t
    );
  end loop;
end $$;

-- store_settings and store_product_settings are per-store config a manager
-- legitimately maintains, so widen those two beyond admin.
drop policy if exists "manager write store_settings" on public.store_settings;
create policy "manager write store_settings"
  on public.store_settings for all to authenticated
  using (public.can_write_store(store_id))
  with check (public.can_write_store(store_id));

drop policy if exists "manager write store_product_settings" on public.store_product_settings;
create policy "manager write store_product_settings"
  on public.store_product_settings for all to authenticated
  using (public.can_write_store(store_id))
  with check (public.can_write_store(store_id));

-- =====================================================================
-- TIER 2 - Operational rows carrying their own store_id.
-- =====================================================================
do $$
declare
  t text;
  tables text[] := array[
    'sales','customers','store_inventory','stock_purchases','stock_damages',
    'stock_requests','sale_returns','cash_drawer_sessions'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists "read %s" on public.%I', t, t);
    execute format(
      'create policy "read %s" on public.%I for select to authenticated '
      'using (public.can_read_store(store_id))',
      t, t
    );

    execute format('drop policy if exists "write %s" on public.%I', t, t);
    execute format(
      'create policy "write %s" on public.%I for all to authenticated '
      'using (public.can_write_store(store_id)) '
      'with check (public.can_write_store(store_id))',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Transfers have two stores. Either side may see and act on the row.
-- ---------------------------------------------------------------------
drop policy if exists "read stock_transfers" on public.stock_transfers;
create policy "read stock_transfers"
  on public.stock_transfers for select to authenticated
  using (public.can_read_store(from_store_id) or public.can_read_store(to_store_id));

drop policy if exists "write stock_transfers" on public.stock_transfers;
create policy "write stock_transfers"
  on public.stock_transfers for all to authenticated
  using (public.can_write_store(from_store_id) or public.can_write_store(to_store_id))
  with check (public.can_write_store(from_store_id) or public.can_write_store(to_store_id));

-- ---------------------------------------------------------------------
-- Settlements are between two stores.
-- ---------------------------------------------------------------------
drop policy if exists "read inter_store_settlements" on public.inter_store_settlements;
create policy "read inter_store_settlements"
  on public.inter_store_settlements for select to authenticated
  using (public.can_read_store(owing_store_id) or public.can_read_store(owed_store_id));

drop policy if exists "write inter_store_settlements" on public.inter_store_settlements;
create policy "write inter_store_settlements"
  on public.inter_store_settlements for all to authenticated
  using (public.can_write_store(owing_store_id) or public.can_write_store(owed_store_id))
  with check (public.can_write_store(owing_store_id) or public.can_write_store(owed_store_id));

-- =====================================================================
-- TIER 3 - Child rows, scoped through their parent.
-- =====================================================================

-- sale_items -> sales
drop policy if exists "read sale_items" on public.sale_items;
create policy "read sale_items"
  on public.sale_items for select to authenticated
  using (exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id and public.can_read_store(s.store_id)
  ));

drop policy if exists "write sale_items" on public.sale_items;
create policy "write sale_items"
  on public.sale_items for all to authenticated
  using (exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id and public.can_write_store(s.store_id)
  ))
  with check (exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id and public.can_write_store(s.store_id)
  ));

-- sale_return_items -> sale_returns
drop policy if exists "read sale_return_items" on public.sale_return_items;
create policy "read sale_return_items"
  on public.sale_return_items for select to authenticated
  using (exists (
    select 1 from public.sale_returns r
    where r.id = sale_return_items.return_id and public.can_read_store(r.store_id)
  ));

drop policy if exists "write sale_return_items" on public.sale_return_items;
create policy "write sale_return_items"
  on public.sale_return_items for all to authenticated
  using (exists (
    select 1 from public.sale_returns r
    where r.id = sale_return_items.return_id and public.can_write_store(r.store_id)
  ))
  with check (exists (
    select 1 from public.sale_returns r
    where r.id = sale_return_items.return_id and public.can_write_store(r.store_id)
  ));

-- cash_movements -> cash_drawer_sessions
drop policy if exists "read cash_movements" on public.cash_movements;
create policy "read cash_movements"
  on public.cash_movements for select to authenticated
  using (exists (
    select 1 from public.cash_drawer_sessions d
    where d.id = cash_movements.session_id and public.can_read_store(d.store_id)
  ));

drop policy if exists "write cash_movements" on public.cash_movements;
create policy "write cash_movements"
  on public.cash_movements for all to authenticated
  using (exists (
    select 1 from public.cash_drawer_sessions d
    where d.id = cash_movements.session_id and public.can_write_store(d.store_id)
  ))
  with check (exists (
    select 1 from public.cash_drawer_sessions d
    where d.id = cash_movements.session_id and public.can_write_store(d.store_id)
  ));

-- ---------------------------------------------------------------------
-- Purchase orders carry no store_id. They are a merchandising function,
-- so they follow role rather than store: global writers manage them,
-- store staff do not see supplier pricing at all.
-- ---------------------------------------------------------------------
drop policy if exists "read purchase_orders" on public.purchase_orders;
create policy "read purchase_orders"
  on public.purchase_orders for select to authenticated
  using (public.is_global_reader());

drop policy if exists "write purchase_orders" on public.purchase_orders;
create policy "write purchase_orders"
  on public.purchase_orders for all to authenticated
  using (public.is_global_writer())
  with check (public.is_global_writer());

drop policy if exists "read purchase_order_items" on public.purchase_order_items;
create policy "read purchase_order_items"
  on public.purchase_order_items for select to authenticated
  using (public.is_global_reader());

drop policy if exists "write purchase_order_items" on public.purchase_order_items;
create policy "write purchase_order_items"
  on public.purchase_order_items for all to authenticated
  using (public.is_global_writer())
  with check (public.is_global_writer());

drop policy if exists "read po_payments" on public.po_payments;
create policy "read po_payments"
  on public.po_payments for select to authenticated
  using (public.is_global_reader());

drop policy if exists "write po_payments" on public.po_payments;
create policy "write po_payments"
  on public.po_payments for all to authenticated
  using (public.is_global_writer())
  with check (public.is_global_writer());

-- ---------------------------------------------------------------------
-- Suppliers hold negotiated pricing and contacts. Reference-tier read
-- was too wide for these; restrict to the roles that buy.
-- ---------------------------------------------------------------------
drop policy if exists "read suppliers" on public.suppliers;
create policy "read suppliers"
  on public.suppliers for select to authenticated
  using (public.is_global_reader());

-- ---------------------------------------------------------------------
-- Indexes the new predicates rely on.
-- ---------------------------------------------------------------------
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
