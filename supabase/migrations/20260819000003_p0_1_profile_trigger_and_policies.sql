-- Trigger guard: freeze privileged columns for non-admins
create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin boolean;
begin
  if auth.uid() is null then
    return new;
  end if;

  select public.is_admin() into v_is_admin;
  if v_is_admin then
    return new;
  end if;

  if new.role         is distinct from old.role         then raise exception 'Not authorised to change role'; end if;
  if new.permissions  is distinct from old.permissions  then raise exception 'Not authorised to change permissions'; end if;
  if new.store_id     is distinct from old.store_id     then raise exception 'Not authorised to change store_id'; end if;
  if new.approval_pin is distinct from old.approval_pin then raise exception 'Not authorised to change approval_pin'; end if;
  if new.id           is distinct from old.id           then raise exception 'Not authorised to change id'; end if;
  if new.email        is distinct from old.email        then raise exception 'Email changes must go through auth'; end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_profile_privileged_columns on public.profiles;
create trigger trg_guard_profile_privileged_columns
  before update on public.profiles
  for each row
  execute function public.guard_profile_privileged_columns();

-- Remove unrestricted self-update
drop policy if exists "users can update own profile" on public.profiles;

-- Admin update policy needs WITH CHECK
drop policy if exists "admin can update all profiles" on public.profiles;
create policy "admin can update all profiles"
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- Only admins create/delete profiles
drop policy if exists "admin can insert profiles" on public.profiles;
create policy "admin can insert profiles"
  on public.profiles for insert
  with check (public.is_admin());

drop policy if exists "admin can delete profiles" on public.profiles;
create policy "admin can delete profiles"
  on public.profiles for delete
  using (public.is_admin());

alter table public.profiles enable row level security;
