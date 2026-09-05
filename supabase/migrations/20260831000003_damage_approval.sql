-- =====================================================================
-- Damage write-off approval
-- Repo path: supabase/migrations/20260831000003_damage_approval.sql
--
-- Until now a damage report was final the moment it was typed: the row
-- went in and the stock came off, with nobody signing for it. That is the
-- easiest way to walk goods out of a shop.
--
-- The goods really are broken, so the stock still comes off immediately -
-- leaving it on the books would make every count wrong until someone got
-- round to approving. What the two stages add is the sign-off on the loss:
--
--   awaiting_approval  -- reported, stock already reduced
--        |  sale manager who covers that store
--        v
--   pending
--        |  warehouse head
--        v
--   approved           -- the write-off stands
--
-- Rejecting at either stage puts the stock back, because a rejected
-- write-off means the goods were not lost after all.
--
-- Idempotent - safe to re-run.
-- =====================================================================

alter table public.stock_damages
  add column if not exists damage_no text,
  add column if not exists status text not null default 'approved',
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists warehouse_approved_by text,
  add column if not exists warehouse_approved_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text,
  add column if not exists unit_cost numeric not null default 0;

-- Existing rows predate the workflow and were already acted on, so they
-- stay 'approved' rather than appearing in someone's queue tomorrow.
alter table public.stock_damages drop constraint if exists stock_damages_status_check;
alter table public.stock_damages add constraint stock_damages_status_check check (
  status in ('awaiting_approval', 'pending', 'approved', 'rejected')
);

create index if not exists idx_stock_damages_status on public.stock_damages (status);
create index if not exists idx_stock_damages_no on public.stock_damages (damage_no);

-- ---------------------------------------------------------------------
-- Reference numbers, one per report rather than per line
-- ---------------------------------------------------------------------

create table if not exists public.damage_ref_counters (
  store_id text not null,
  day date not null,
  seq integer not null default 0,
  primary key (store_id, day)
);

alter table public.damage_ref_counters enable row level security;

drop policy if exists "counters are internal" on public.damage_ref_counters;
create policy "counters are internal"
  on public.damage_ref_counters for select to authenticated
  using (public.is_director());

create or replace function public.next_damage_no(p_store_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq integer;
begin
  insert into public.damage_ref_counters (store_id, day, seq)
  values (p_store_id, current_date, 1)
  on conflict (store_id, day)
  do update set seq = public.damage_ref_counters.seq + 1
  returning seq into v_seq;

  return format('DMG-%s-%s-%s',
    replace(p_store_id, '-', ''),
    to_char(current_date, 'YYMMDD'),
    lpad(v_seq::text, 4, '0'));
end;
$$;

-- ---------------------------------------------------------------------
-- Reporting a write-off
--
-- Takes every line in one call so the report gets one number, the stock
-- moves once, and a half-finished report cannot be left behind.
-- ---------------------------------------------------------------------

create or replace function public.report_damage(
  p_store_id text,
  p_lines jsonb,          -- [{product_id, variant_id, qty, reason}]
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text;
  v_no text;
  v_line jsonb;
  v_qty numeric;
  v_cost numeric;
  v_have numeric;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then
    raise exception 'not signed in';
  end if;

  if not public.can_write_store(p_store_id) then
    raise exception 'you cannot report damage for %', p_store_id;
  end if;

  if jsonb_array_length(p_lines) = 0 then
    raise exception 'nothing to report';
  end if;

  v_no := public.next_damage_no(p_store_id);

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'quantity must be positive';
    end if;

    -- Lock the inventory row before reading it, so two people reporting
    -- the same breakage cannot both take it off the same stock figure.
    select stock_qty, coalesce(avg_cost, 0)
    into v_have, v_cost
    from public.store_inventory
    where store_id = p_store_id
      and product_id = (v_line->>'product_id')::uuid
      and variant_id is not distinct from nullif(v_line->>'variant_id', '')::uuid
    for update;

    if not found then
      raise exception 'that product is not stocked here';
    end if;

    if v_have < v_qty then
      raise exception 'only % in stock', v_have;
    end if;

    update public.store_inventory
    set stock_qty = stock_qty - v_qty
    where store_id = p_store_id
      and product_id = (v_line->>'product_id')::uuid
      and variant_id is not distinct from nullif(v_line->>'variant_id', '')::uuid;

    insert into public.stock_damages (
      store_id, product_id, variant_id, qty, reason,
      reported_by, damage_no, status, unit_cost
    ) values (
      p_store_id,
      (v_line->>'product_id')::uuid,
      nullif(v_line->>'variant_id', '')::uuid,
      v_qty,
      coalesce(v_line->>'reason', p_note),
      v_actor,
      v_no,
      'awaiting_approval',
      v_cost
    );
  end loop;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type)
  values (v_actor, auth.uid(), 'damage_reported',
          format('%s · %s · %s lines', v_no, p_store_id, jsonb_array_length(p_lines)),
          'stock_damage');

  return v_no;
end;
$$;

-- ---------------------------------------------------------------------
-- Stage one: the sale manager for that store
-- ---------------------------------------------------------------------

create or replace function public.approve_damage(
  p_damage_no text,
  p_reject boolean default false,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text;
  v_store text;
  v_reporter text;
  v_count integer;
  v_row record;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then
    raise exception 'not signed in';
  end if;

  select store_id, reported_by into v_store, v_reporter
  from public.stock_damages
  where damage_no = p_damage_no and status = 'awaiting_approval'
  limit 1;

  if v_store is null then
    raise exception 'nothing awaiting approval under %', p_damage_no;
  end if;

  if not (
    public.can_approve_for_email(v_reporter)
    or public.can_approve_dept('sale', v_store)
  ) then
    raise exception 'you are not the approver for this write-off';
  end if;

  -- A rejected write-off means the goods were never lost, so the stock
  -- that was taken off at reporting time goes back on.
  if p_reject then
    for v_row in
      select product_id, variant_id, qty
      from public.stock_damages
      where damage_no = p_damage_no and status = 'awaiting_approval'
    loop
      update public.store_inventory
      set stock_qty = stock_qty + v_row.qty
      where store_id = v_store
        and product_id = v_row.product_id
        and variant_id is not distinct from v_row.variant_id;
    end loop;
  end if;

  update public.stock_damages
  set status = case when p_reject then 'rejected' else 'pending' end,
      approved_by = case when p_reject then approved_by else v_actor end,
      approved_at = case when p_reject then approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      reject_reason = case when p_reject then p_reason else reject_reason end
  where damage_no = p_damage_no and status = 'awaiting_approval';

  get diagnostics v_count = row_count;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type)
  values (v_actor, auth.uid(),
          case when p_reject then 'damage_rejected' else 'damage_approved' end,
          format('%s · %s · %s', p_damage_no, v_store, coalesce(p_reason, '')),
          'stock_damage');

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Stage two: the warehouse head confirms the loss against the books
-- ---------------------------------------------------------------------

create or replace function public.warehouse_confirm_damage(
  p_damage_no text,
  p_reject boolean default false,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text;
  v_store text;
  v_count integer;
  v_row record;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then
    raise exception 'not signed in';
  end if;

  select store_id into v_store
  from public.stock_damages
  where damage_no = p_damage_no and status = 'pending'
  limit 1;

  if v_store is null then
    raise exception 'nothing waiting on the warehouse under %', p_damage_no;
  end if;

  if not public.can_approve_dept('warehouse') then
    raise exception 'only the warehouse head can confirm a write-off';
  end if;

  if p_reject then
    for v_row in
      select product_id, variant_id, qty
      from public.stock_damages
      where damage_no = p_damage_no and status = 'pending'
    loop
      update public.store_inventory
      set stock_qty = stock_qty + v_row.qty
      where store_id = v_store
        and product_id = v_row.product_id
        and variant_id is not distinct from v_row.variant_id;
    end loop;
  end if;

  update public.stock_damages
  set status = case when p_reject then 'rejected' else 'approved' end,
      warehouse_approved_by = case when p_reject then warehouse_approved_by else v_actor end,
      warehouse_approved_at = case when p_reject then warehouse_approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      reject_reason = case when p_reject then p_reason else reject_reason end
  where damage_no = p_damage_no and status = 'pending';

  get diagnostics v_count = row_count;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type)
  values (v_actor, auth.uid(),
          case when p_reject then 'damage_wh_rejected' else 'damage_wh_confirmed' end,
          format('%s · %s · %s', p_damage_no, v_store, coalesce(p_reason, '')),
          'stock_damage');

  return v_count;
end;
$$;

revoke all on function public.next_damage_no(text) from public, anon;
revoke all on function public.report_damage(text, jsonb, text) from public, anon;
revoke all on function public.approve_damage(text, boolean, text) from public, anon;
revoke all on function public.warehouse_confirm_damage(text, boolean, text) from public, anon;

grant execute on function public.report_damage(text, jsonb, text) to authenticated;
grant execute on function public.approve_damage(text, boolean, text) to authenticated;
grant execute on function public.warehouse_confirm_damage(text, boolean, text) to authenticated;
