-- =====================================================================
-- P0-1 (part 1 of 2): Authorization helper functions
-- Repo path: supabase/migrations/20260819000002_p0_1_correct_is_admin_scope.sql
--
-- Must run BEFORE 20260819000003_p0_1_profile_trigger_and_policies.sql,
-- which depends on public.is_admin().
--
-- Hardening applied to the pre-existing is_admin():
--   * search_path pinned to (public, pg_temp) to block search_path hijack
--   * marked STABLE so the planner can cache it within a statement
--   * execute revoked from public/anon
-- Scope deliberately stays admin-only. Owners get read-wide access via
-- is_owner_or_admin(), NOT user/permission administration.
--
-- Idempotent - safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- is_admin(): user and security administration only
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- is_owner_or_admin(): read-wide access across all stores.
-- Used by P0-2 RLS policies for cross-store reporting visibility.
-- ---------------------------------------------------------------------
create or replace function public.is_owner_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'owner')
  );
$$;

revoke all on function public.is_owner_or_admin() from public, anon;
grant execute on function public.is_owner_or_admin() to authenticated;
