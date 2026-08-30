-- =====================================================================
-- Organisation structure: departments, reporting lines, approval rights
-- Repo path: supabase/migrations/20260831000001_org_structure.sql
--
-- Until now "manager" meant one person who could approve everything. A
-- business with five departments and two sale managers covering different
-- stores needs to say who approves what, for whom.
--
-- Three things change:
--   * every profile belongs to a department and reports to someone
--   * a manager's scope is a set of stores and channels, not one store_id
--   * approval asks can_approve_for(requester), not "is this a manager"
--
-- The old single-store column stays: cashiers still have exactly one, and
-- every existing policy reads it. user_stores is additive - it widens
-- scope for people who need several branches.
--
-- Idempotent - safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Departments and reporting lines
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'department') then
    create type public.department as enum (
      'sale', 'merchandising', 'warehouse', 'finance', 'marketing'
    );
  end if;
end $$;

alter table public.profiles
  add column if not exists department public.department,
  add column if not exists reports_to uuid references public.profiles(id),
  add column if not exists is_dept_head boolean not null default false;

create index if not exists profiles_reports_to_idx on public.profiles (reports_to);
create index if not exists profiles_department_idx on public.profiles (department);

-- A manager can cover several branches; a cashier still has exactly one.
create table if not exists public.user_stores (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  store_id text not null references public.stores(id) on delete cascade,
  primary key (user_id, store_id)
);

alter table public.user_stores enable row level security;

drop policy if exists "read own store scope" on public.user_stores;
create policy "read own store scope"
  on public.user_stores for select to authenticated
  using (user_id = auth.uid() or public.is_admin() or public.is_global_reader());

drop policy if exists "admin manages store scope" on public.user_stores;
create policy "admin manages store scope"
  on public.user_stores for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Sale managers may also be split by channel rather than by branch.
create table if not exists public.user_channels (
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('pos', 'online', 'wholesale')),
  primary key (user_id, channel)
);

alter table public.user_channels enable row level security;

drop policy if exists "read own channel scope" on public.user_channels;
create policy "read own channel scope"
  on public.user_channels for select to authenticated
  using (user_id = auth.uid() or public.is_admin() or public.is_global_reader());

drop policy if exists "admin manages channel scope" on public.user_channels;
create policy "admin manages channel scope"
  on public.user_channels for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 2. New roles
--
-- 'manager' is replaced by one head per department. Existing managers are
-- migrated below; the old value stays in the check constraint so rows are
-- never orphaned mid-deploy.
-- ---------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (
  role in (
    'admin', 'owner', 'operation_director',
    'sale_manager', 'merchandising_manager', 'warehouse_manager',
    'finance_manager', 'marketing_manager',
    'manager',                          -- legacy, migrated below
    'online_sale', 'cashier', 'wholesale'
  )
);

-- Anyone still on the old blanket role becomes a sale manager: that is the
-- closest match to what they were actually doing day to day.
update public.profiles
set role = 'sale_manager', department = 'sale', is_dept_head = true
where role = 'manager';

-- Give everyone a department so approval routing has something to read.
update public.profiles set department = 'sale'
where department is null and role in ('cashier', 'online_sale', 'wholesale', 'sale_manager');

update public.profiles set department = 'warehouse'
where department is null and role = 'warehouse_manager';

update public.profiles set department = 'merchandising'
where department is null and role = 'merchandising_manager';

update public.profiles set department = 'finance'
where department is null and role = 'finance_manager';

update public.profiles set department = 'marketing'
where department is null and role = 'marketing_manager';

-- Existing single-store assignments become the first row of the new scope.
insert into public.user_stores (user_id, store_id)
select id, store_id from public.profiles
where store_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. Scope helpers
-- ---------------------------------------------------------------------

create or replace function public.my_department()
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select department::text from public.profiles where id = auth.uid();
$$;

create or replace function public.is_director()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'owner', 'operation_director')
  );
$$;

create or replace function public.is_dept_head(p_department text default null)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and is_dept_head
      and (p_department is null or department::text = p_department)
  );
$$;

-- Every store this account covers: its own, plus anything granted through
-- user_stores. Directors cover all of them.
create or replace function public.my_stores()
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select s.id from public.stores s where public.is_director()
  union
  select us.store_id from public.user_stores us where us.user_id = auth.uid()
  union
  select p.store_id from public.profiles p
  where p.id = auth.uid() and p.store_id is not null;
$$;

create or replace function public.covers_store(p_store_id text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_store_id is not null
     and exists (select 1 from public.my_stores() ms where ms = p_store_id);
$$;

-- ---------------------------------------------------------------------
-- 4. Who may approve whose request
--
-- Three ways to qualify, in order of how often they apply:
--   * you are their line manager
--   * you head their department and cover their store
--   * you are a director, who may approve anything
-- ---------------------------------------------------------------------

create or replace function public.can_approve_for(p_requester uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p_requester is not null
    and auth.uid() is not null
    and p_requester <> auth.uid()          -- nobody signs off their own request
    and (
      public.is_director()
      or exists (
        select 1 from public.profiles r
        where r.id = p_requester and r.reports_to = auth.uid()
      )
      or exists (
        select 1
        from public.profiles r, public.profiles me
        where r.id = p_requester
          and me.id = auth.uid()
          and me.is_dept_head
          and me.department = r.department
          and (r.store_id is null or public.covers_store(r.store_id))
      )
    );
$$;

-- Same question, asked by email - most tables record who requested by email
-- rather than by id.
create or replace function public.can_approve_for_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_approve_for(
    (select id from public.profiles where email = p_email limit 1)
  );
$$;

-- Department-level approval that does not depend on who filed it: the
-- warehouse head signs off warehouse work regardless of which branch asked.
create or replace function public.can_approve_dept(p_department text, p_store_id text default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.is_director()
    or exists (
      select 1 from public.profiles me
      where me.id = auth.uid()
        and me.is_dept_head
        and me.department::text = p_department
        and (p_store_id is null or public.covers_store(p_store_id))
    );
$$;

revoke all on function public.can_approve_for(uuid) from public, anon;
revoke all on function public.can_approve_for_email(text) from public, anon;
revoke all on function public.can_approve_dept(text, text) from public, anon;
revoke all on function public.my_stores() from public, anon;
revoke all on function public.covers_store(text) from public, anon;
revoke all on function public.my_department() from public, anon;
revoke all on function public.is_director() from public, anon;
revoke all on function public.is_dept_head(text) from public, anon;

grant execute on function public.can_approve_for(uuid) to authenticated;
grant execute on function public.can_approve_for_email(text) to authenticated;
grant execute on function public.can_approve_dept(text, text) to authenticated;
grant execute on function public.my_stores() to authenticated;
grant execute on function public.covers_store(text) to authenticated;
grant execute on function public.my_department() to authenticated;
grant execute on function public.is_director() to authenticated;
grant execute on function public.is_dept_head(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Widen the existing RLS scope helpers
--
-- can_read_store / can_write_store already gate twenty-odd tables. Rather
-- than rewrite every policy, they now consult the new multi-store scope.
-- ---------------------------------------------------------------------

create or replace function public.is_global_reader()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in (
        'admin', 'owner', 'operation_director',
        'sale_manager', 'merchandising_manager', 'warehouse_manager',
        'finance_manager', 'marketing_manager', 'manager', 'online_sale'
      )
  );
$$;

create or replace function public.can_read_store(p_store_id text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_global_reader() or public.covers_store(p_store_id);
$$;

create or replace function public.can_write_store(p_store_id text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select
    public.is_director()
    or public.covers_store(p_store_id)
    or exists (
      select 1 from public.profiles
      where id = auth.uid()
        and is_dept_head
        and department in ('sale', 'warehouse', 'merchandising')
    );
$$;
