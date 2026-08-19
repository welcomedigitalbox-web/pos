-- ============================================
-- Admin system: permissions, receipt settings, payment methods
-- ============================================

-- 1. Permission array on profiles (per-user, per-page access control)
alter table profiles add column if not exists permissions jsonb not null default '[]'::jsonb;

-- Helper function to check admin role without RLS recursion
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- Allow admin to view/update ANY profile (existing "own profile" policies stay, OR'd together)
create policy "admin can view all profiles" on profiles
  for select using (public.is_admin());
create policy "admin can update all profiles" on profiles
  for update using (public.is_admin());

-- 2. Store settings (receipt customization: business name, phone, footer, logo text)
create table if not exists store_settings (
  store_id text primary key,
  business_name text,
  phone text,
  address text,
  receipt_footer text,
  logo_text text,
  updated_at timestamptz default now()
);
alter table store_settings enable row level security;
create policy "authenticated read/write - store_settings" on store_settings
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- 3. Payment methods (admin-managed, per store)
create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  store_id text not null,
  name text not null,
  code text not null,
  is_cash boolean not null default false,
  is_cod boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz default now()
);
create index idx_payment_methods_store on payment_methods(store_id);
alter table payment_methods enable row level security;
create policy "authenticated read/write - payment_methods" on payment_methods
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Remove old hardcoded check constraint on sales.payment_method (now free text, backed by payment_methods.code)
alter table sales drop constraint if exists sales_payment_method_check;

-- Seed default payment methods for each existing store
insert into payment_methods (store_id, name, code, is_cash, is_cod, sort_order)
select s, m.name, m.code, m.is_cash, m.is_cod, m.sort_order
from (values ('SR-BAK'),('SR-MDY'),('SR-NOKL'),('SR-WZYD')) as stores(s)
cross join (values
  ('Cash','cash', true, false, 1),
  ('Card','card', false, false, 2),
  ('Bank Transfer','bank_transfer', false, false, 3),
  ('COD','cod', false, true, 4)
) as m(name, code, is_cash, is_cod, sort_order);

-- ============================================
-- Make the first admin: run this AFTER creating your own login user via
-- Supabase Auth dashboard (or the new Admin Users page once deployed)
-- ============================================
-- update profiles set role = 'admin', permissions = '["pos","history","products","stock-in","barcode","ledger","warehouse","dashboard","admin"]'::jsonb
--   where email = 'YOUR_ADMIN_EMAIL';
