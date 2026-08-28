-- P0-8: Make the audit trail trustworthy.
-- Server-derived actor, append-only, no direct client writes.

alter table public.activity_log
  add column if not exists actor_id uuid references public.profiles(id);

create index if not exists idx_activity_log_created_at
  on public.activity_log (created_at desc);

create index if not exists idx_activity_log_entity
  on public.activity_log (entity_type, entity_id);

create or replace function public.log_activity(
  p_entity_type text,
  p_action      text,
  p_entity_id   uuid default null,
  p_detail      text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_entity_type is null or btrim(p_entity_type) = ''
     or p_action is null or btrim(p_action) = '' then
    raise exception 'entity_type and action are required';
  end if;

  select email into v_email from public.profiles where id = v_uid;

  insert into public.activity_log
    (entity_type, entity_id, action, detail, actor, actor_id)
  values
    (p_entity_type, p_entity_id, p_action, left(p_detail, 2000),
     coalesce(v_email, v_uid::text), v_uid);
end;
$$;

revoke all on function public.log_activity(text, text, uuid, text) from public, anon;
grant execute on function public.log_activity(text, text, uuid, text) to authenticated;

drop policy if exists "authenticated insert - activity_log" on public.activity_log;
drop policy if exists "authenticated read - activity_log"   on public.activity_log;
drop policy if exists "authenticated read/write - activity_log" on public.activity_log;

create policy "read activity_log"
  on public.activity_log for select
  to authenticated
  using (true);

alter table public.activity_log enable row level security;

revoke insert, update, delete on public.activity_log from authenticated, anon;
grant select on public.activity_log to authenticated;

create or replace function public.activity_log_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'activity_log is append-only';
end;
$$;

drop trigger if exists trg_activity_log_append_only on public.activity_log;
create trigger trg_activity_log_append_only
  before update or delete on public.activity_log
  for each row
  execute function public.activity_log_is_append_only();
