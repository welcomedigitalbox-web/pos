-- ============================================
-- Purchase Order module
--   Merchandising raises POs -> receives goods -> Warehouse transfers to stores
--   Payment terms: advance / COD / credit (pay later) / already paid
-- ============================================

-- ---- Suppliers ----
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address text,
  note text,
  is_active boolean not null default true,
  created_at timestamptz default now()
);
alter table suppliers enable row level security;
create policy "authenticated read/write - suppliers" on suppliers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---- Purchase Orders ----
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null,
  supplier_id uuid references suppliers(id),
  status text not null default 'draft'
    check (status in ('draft','ordered','partial','received','cancelled')),
  payment_term text not null default 'credit'
    check (payment_term in ('advance','cod','credit','paid')),
  order_date date not null default current_date,
  expected_date date,
  note text,
  created_by text,
  created_at timestamptz default now()
);
create index idx_purchase_orders_supplier on purchase_orders(supplier_id);
create index idx_purchase_orders_status on purchase_orders(status);
alter table purchase_orders enable row level security;
create policy "authenticated read/write - purchase_orders" on purchase_orders
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---- PO line items ----
create table if not exists purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id),
  variant_id uuid references product_variants(id),
  qty numeric not null,
  unit_cost numeric not null default 0,
  received_qty numeric not null default 0,
  -- When ticked at receiving time, avg_cost is REPLACED by this unit cost
  -- (latest cost). Otherwise the usual moving-average calculation applies.
  update_cost boolean not null default false,
  created_at timestamptz default now()
);
create index idx_po_items_po on purchase_order_items(po_id);
alter table purchase_order_items enable row level security;
create policy "authenticated read/write - purchase_order_items" on purchase_order_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---- Payments made against a PO (supports advance + instalments) ----
create table if not exists po_payments (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references purchase_orders(id) on delete cascade,
  amount numeric not null,
  paid_at date not null default current_date,
  method text,
  note text,
  paid_by text,
  created_at timestamptz default now()
);
create index idx_po_payments_po on po_payments(po_id);
alter table po_payments enable row level security;
create policy "authenticated read/write - po_payments" on po_payments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ---- Consignment products always use moving-average cost ----
alter table products add column if not exists is_consignment boolean not null default false;

-- ---- Link received batches back to their PO for traceability ----
alter table stock_purchases add column if not exists po_id uuid references purchase_orders(id);
