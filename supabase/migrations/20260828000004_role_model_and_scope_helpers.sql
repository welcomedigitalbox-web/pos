-- =====================================================================
-- 20260828000004: Correct the role model, add RLS scope helpers
-- Repo path: supabase/migrations/20260828000004_role_model_and_scope_helpers.sql
--
-- Two corrections and one addition:
--
--   1. sale_manager is restored as an approver. P0-5 dropped it because no
--      profile currently carries that role, but permissions.ts defines it
--      as a real role - it simply has no users yet.
--
--   2. The role list is now stated once, in SQL, so RLS policies and the
--      Edge Function cannot drift apart the way they had.
--
--   3. Scope helpers used by every policy in the next migration.
--
-- Scope model (agreed with the business):
--   admin        - everything, including user administration
--   owner        - reads every store, approves, no user administration
--   manager      - reads every store, operational writes anywhere
--   sale_manager - reads every store, sale-side writes anywhere
--   online_sale  - reads stock everywhere (needs to find which store or
--                  warehouse holds an item to fulfil an online order),
--                  writes sales against the fulfilling store
--   cashier      - single store, the one on their profile
--   wholesale    - single store, the one on their profile
--
-- Idempotent - safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Approvers: sale_manager restored
-- ---------------------------------------------------------------------
create or replace function public.is_approver_role(p_role text)
returns boolean
language sql
immutable
as $$
  select p_role in ('admin', 'owner', 'manager', 'sale_manager');
$$;

-- ---------------------------------------------------------------------
-- The caller's role, read once. SECURITY DEFINER so policies that call
-- it do not recurse back through profiles' own RLS.
-- ---------------------------------------------------------------------
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = auth.uid();
$$;

revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;

-- ---------------------------------------------------------------------
-- Roles that see every store. online_sale is included because order
-- fulfilment starts by locating stock across all stores and warehouses.
-- ---------------------------------------------------------------------
create or replace function public.is_global_reader()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.my_role() in
    ('admin', 'owner', 'manager', 'sale_manager', 'online_sale');
$$;

revoke all on function public.is_global_reader() from public, anon;
grant execute on function public.is_global_reader() to authenticated;

-- ---------------------------------------------------------------------
-- Roles that may write operational rows for any store. Same set minus
-- owner, whose role is to approve and review rather than transact.
-- ---------------------------------------------------------------------
create or replace function public.is_global_writer()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.my_role() in
    ('admin', 'manager', 'sale_manager', 'online_sale');
$$;

revoke all on function public.is_global_writer() from public, anon;
grant execute on function public.is_global_writer() to authenticated;

-- ---------------------------------------------------------------------
-- The single store a locked account belongs to, or null.
-- ---------------------------------------------------------------------
create or replace function public.my_store_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select store_id from public.profiles where id = auth.uid();
$$;

revoke all on function public.my_store_id() from public, anon;
grant execute on function public.my_store_id() to authenticated;

-- ---------------------------------------------------------------------
-- The two predicates every policy in the next migration is built from.
-- A null store_id on a row is treated as visible to global readers only.
-- ---------------------------------------------------------------------
create or replace function public.can_read_store(p_store_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_global_reader()
      or (p_store_id is not null and p_store_id = public.my_store_id());
$$;

revoke all on function public.can_read_store(text) from public, anon;
grant execute on function public.can_read_store(text) to authenticated;

create or replace function public.can_write_store(p_store_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_global_writer()
      or (p_store_id is not null and p_store_id = public.my_store_id());
$$;

revoke all on function public.can_write_store(text) from public, anon;
grant execute on function public.can_write_store(text) to authenticated;
