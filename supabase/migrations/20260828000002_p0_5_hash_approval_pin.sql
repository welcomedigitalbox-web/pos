-- =====================================================================
-- P0-5: Hash approval PINs, add brute-force lockout
-- Repo path: supabase/migrations/20260828000002_p0_5_hash_approval_pin.sql
--
-- Before: profiles.approval_pin held a 4-6 digit PIN in plaintext, and
-- the Edge Function matched it with .eq("approval_pin", pin) across ALL
-- approver profiles - no rate limit, so a 10,000-guess sweep granted
-- approval authority.
--
-- After:
--   * PINs stored as bcrypt hashes (pgcrypto)
--   * plaintext column dropped
--   * verification only via verify_approval_pin() RPC
--   * 5 failed attempts locks the CALLER out for 15 minutes
--   * every attempt written to activity_log
--
-- Existing PINs are migrated in place - nobody has to re-enter theirs.
-- Idempotent - safe to re-run.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists approval_pin_hash    text,
  add column if not exists approval_pin_set_at  timestamptz,
  add column if not exists pin_attempts         integer     not null default 0,
  add column if not exists pin_locked_until     timestamptz;

-- ---------------------------------------------------------------------
-- 2. Migrate existing plaintext PINs to bcrypt, then drop the column
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'approval_pin'
  ) then
    update public.profiles
    set approval_pin_hash = extensions.crypt(approval_pin, extensions.gen_salt('bf', 10)),
        approval_pin_set_at = now()
    where approval_pin is not null
      and approval_pin <> ''
      and approval_pin_hash is null;

    alter table public.profiles drop column approval_pin;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Rebuild the P0-1 trigger: approval_pin is gone, guard the hash and
--    the lockout counters instead so a user cannot reset their own
--    lockout or write a hash directly.
-- ---------------------------------------------------------------------
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

  if new.role              is distinct from old.role              then raise exception 'Not authorised to change role'; end if;
  if new.permissions       is distinct from old.permissions       then raise exception 'Not authorised to change permissions'; end if;
  if new.store_id          is distinct from old.store_id          then raise exception 'Not authorised to change store_id'; end if;
  if new.id                is distinct from old.id                then raise exception 'Not authorised to change id'; end if;
  if new.email             is distinct from old.email             then raise exception 'Email changes must go through auth'; end if;
  if new.approval_pin_hash is distinct from old.approval_pin_hash then raise exception 'Set your PIN with set_my_approval_pin()'; end if;
  if new.pin_attempts      is distinct from old.pin_attempts      then raise exception 'Not authorised to change pin_attempts'; end if;
  if new.pin_locked_until  is distinct from old.pin_locked_until  then raise exception 'Not authorised to change pin_locked_until'; end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_profile_privileged_columns on public.profiles;
create trigger trg_guard_profile_privileged_columns
  before update on public.profiles
  for each row
  execute function public.guard_profile_privileged_columns();

-- ---------------------------------------------------------------------
-- 4. Who may approve. Single source of truth - the Edge Function's
--    hardcoded list named roles ('sale_manager', 'owner') that do not
--    exist in this database.
-- ---------------------------------------------------------------------
create or replace function public.is_approver_role(p_role text)
returns boolean
language sql
immutable
as $$
  select p_role in ('admin', 'owner', 'manager');
$$;

-- ---------------------------------------------------------------------
-- 5. Set your own PIN. Bypasses the trigger by design (SECURITY DEFINER)
--    but only ever writes the caller's own row.
-- ---------------------------------------------------------------------
create or replace function public.set_my_approval_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select role into v_role from public.profiles where id = auth.uid();

  if not public.is_approver_role(v_role) then
    raise exception 'Your role cannot hold an approval PIN';
  end if;

  if p_pin !~ '^\d{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits';
  end if;

  -- Reject the most obvious guesses; these defeat the lockout's purpose.
  if p_pin in ('0000','1111','2222','3333','4444','5555','6666','7777',
               '8888','9999','1234','4321','000000','123456','654321') then
    raise exception 'That PIN is too easy to guess';
  end if;

  update public.profiles
  set approval_pin_hash   = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
      approval_pin_set_at = now(),
      pin_attempts        = 0,
      pin_locked_until    = null
  where id = auth.uid();
end;
$$;

revoke all on function public.set_my_approval_pin(text) from public, anon;
grant execute on function public.set_my_approval_pin(text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Verify a PIN. Returns the approver on success, raises on failure.
--    Lockout is tracked against the CALLER, so sweeping the PIN space
--    from one cashier session stops after 5 tries.
-- ---------------------------------------------------------------------
create or replace function public.verify_approval_pin(p_pin text)
returns table (approver_id uuid, approver_email text, approver_role text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller       uuid := auth.uid();
  v_locked_until timestamptz;
  v_attempts     integer;
  v_match        record;
begin
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  select pin_locked_until, pin_attempts
    into v_locked_until, v_attempts
  from public.profiles where id = v_caller;

  if v_locked_until is not null and v_locked_until > now() then
    raise exception 'Too many failed attempts. Try again after %',
      to_char(v_locked_until, 'HH24:MI');
  end if;

  select p.id, p.email, p.role
    into v_match
  from public.profiles p
  where p.approval_pin_hash is not null
    and public.is_approver_role(p.role)
    and p.approval_pin_hash = extensions.crypt(p_pin, p.approval_pin_hash)
  limit 1;

  if v_match.id is null then
    update public.profiles
    set pin_attempts = pin_attempts + 1,
        pin_locked_until = case
          when pin_attempts + 1 >= 5 then now() + interval '15 minutes'
          else pin_locked_until
        end
    where id = v_caller;

    insert into activity_log (entity_type, entity_id, action, detail, actor)
    values ('approval_pin', v_caller, 'pin_failed',
            'incorrect approval PIN', v_caller::text);

    raise exception 'Invalid PIN';
  end if;

  update public.profiles
  set pin_attempts = 0, pin_locked_until = null
  where id = v_caller;

  insert into activity_log (entity_type, entity_id, action, detail, actor)
  values ('approval_pin', v_match.id, 'pin_verified',
          format('approved by %s', v_match.email), v_caller::text);

  approver_id    := v_match.id;
  approver_email := v_match.email;
  approver_role  := v_match.role;
  return next;
end;
$$;

revoke all on function public.verify_approval_pin(text) from public, anon;
grant execute on function public.verify_approval_pin(text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Convenience: does the caller have a PIN set? Avoids the client
--    needing to read anything PIN-related off the profiles row.
-- ---------------------------------------------------------------------
create or replace function public.my_approval_pin_status()
returns table (has_pin boolean, set_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select approval_pin_hash is not null, approval_pin_set_at
  from public.profiles where id = auth.uid();
$$;

revoke all on function public.my_approval_pin_status() from public, anon;
grant execute on function public.my_approval_pin_status() to authenticated;
