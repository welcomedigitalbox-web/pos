-- =====================================================================
-- Damage: batch deduction belongs inside the report
-- Repo path: supabase/migrations/20260831000004_damage_fefo.sql
--
-- report_damage took the stock off store_inventory but left the batch
-- rows in stock_purchases untouched. The page was walking the batches
-- itself, one UPDATE at a time, after the insert had already landed - so
-- a dropped connection halfway through left the inventory short and the
-- batches long, and every cost figure drawn from them wrong.
--
-- The same loop now runs inside the function, in the same transaction as
-- the stock movement, oldest expiry first.
--
-- Idempotent - safe to re-run.
-- =====================================================================

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
  v_product uuid;
  v_variant uuid;
  v_qty numeric;
  v_cost numeric;
  v_have numeric;
  v_left numeric;
  v_take numeric;
  v_batch record;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then
    raise exception 'not signed in';
  end if;

  if not public.can_write_store(p_store_id) then
    raise exception 'you cannot report damage for %', p_store_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'nothing to report';
  end if;

  v_no := public.next_damage_no(p_store_id);

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product := (v_line->>'product_id')::uuid;
    v_variant := nullif(v_line->>'variant_id', '')::uuid;
    v_qty := (v_line->>'qty')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'quantity must be positive';
    end if;

    -- Lock before reading: two people reporting the same breakage must
    -- not both subtract from the same starting figure.
    select stock_qty, coalesce(avg_cost, 0)
    into v_have, v_cost
    from public.store_inventory
    where store_id = p_store_id
      and product_id = v_product
      and variant_id is not distinct from v_variant
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
      and product_id = v_product
      and variant_id is not distinct from v_variant;

    -- Take the loss off the batches that would have sold first, so the
    -- remaining batch quantities still add up to the stock on hand.
    v_left := v_qty;
    for v_batch in
      select id, remaining_qty
      from public.stock_purchases
      where store_id = p_store_id
        and product_id = v_product
        and variant_id is not distinct from v_variant
        and remaining_qty > 0
      order by expiry_date asc nulls last, created_at asc
      for update
    loop
      exit when v_left <= 0;
      v_take := least(v_batch.remaining_qty, v_left);
      update public.stock_purchases
      set remaining_qty = remaining_qty - v_take
      where id = v_batch.id;
      v_left := v_left - v_take;
    end loop;

    insert into public.stock_damages (
      store_id, product_id, variant_id, qty, reason,
      reported_by, damage_no, status, unit_cost
    ) values (
      p_store_id, v_product, v_variant, v_qty,
      coalesce(v_line->>'reason', p_note),
      v_actor, v_no, 'awaiting_approval', v_cost
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
-- Putting stock back on a rejection has to put the batches back too
-- ---------------------------------------------------------------------

create or replace function public.restore_damaged_stock(p_damage_no text, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_left numeric;
  v_take numeric;
  v_batch record;
begin
  for v_row in
    select store_id, product_id, variant_id, qty
    from public.stock_damages
    where damage_no = p_damage_no and status = p_status
  loop
    update public.store_inventory
    set stock_qty = stock_qty + v_row.qty
    where store_id = v_row.store_id
      and product_id = v_row.product_id
      and variant_id is not distinct from v_row.variant_id;

    -- Return the units to the batches they came off, newest expiry first,
    -- which reverses the order they were taken in.
    v_left := v_row.qty;
    for v_batch in
      select id, qty, remaining_qty
      from public.stock_purchases
      where store_id = v_row.store_id
        and product_id = v_row.product_id
        and variant_id is not distinct from v_row.variant_id
        and remaining_qty < qty
      order by expiry_date desc nulls first, created_at desc
      for update
    loop
      exit when v_left <= 0;
      v_take := least(v_batch.qty - v_batch.remaining_qty, v_left);
      update public.stock_purchases
      set remaining_qty = remaining_qty + v_take
      where id = v_batch.id;
      v_left := v_left - v_take;
    end loop;
  end loop;
end;
$$;

-- Both approval stages now restore batches as well as inventory.
create or replace function public.approve_damage(
  p_damage_no text, p_reject boolean default false, p_reason text default null
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor text; v_store text; v_reporter text; v_count integer;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  select store_id, reported_by into v_store, v_reporter
  from public.stock_damages
  where damage_no = p_damage_no and status = 'awaiting_approval'
  limit 1;

  if v_store is null then
    raise exception 'nothing awaiting approval under %', p_damage_no;
  end if;

  if not (public.can_approve_for_email(v_reporter)
          or public.can_approve_dept('sale', v_store)) then
    raise exception 'you are not the approver for this write-off';
  end if;

  if p_reject then
    perform public.restore_damaged_stock(p_damage_no, 'awaiting_approval');
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
end; $$;

create or replace function public.warehouse_confirm_damage(
  p_damage_no text, p_reject boolean default false, p_reason text default null
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor text; v_store text; v_count integer;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

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
    perform public.restore_damaged_stock(p_damage_no, 'pending');
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
end; $$;

revoke all on function public.restore_damaged_stock(text, text) from public, anon;
