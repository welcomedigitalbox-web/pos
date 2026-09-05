-- =====================================================================
-- send_transfer: one dispatch, many lines, all or nothing
-- Repo path: supabase/migrations/20260830000001_send_transfer.sql
--
-- Sending five products used to mean five separate client-side writes. A
-- dropped connection between them left the warehouse short of stock with no
-- transfer to show for it - goods that simply vanish from the books.
--
-- This does the whole dispatch in one transaction: quantities are checked
-- against locked rows first, so either every line goes out or none does.
-- Cost is stamped onto each line, because the receiving store cannot read
-- the warehouse's inventory through RLS.
--
-- Idempotent - safe to re-run.
-- =====================================================================

alter table public.stock_transfers
  add column if not exists transfer_no text,
  add column if not exists idempotency_key uuid;

create index if not exists stock_transfers_transfer_no_idx
  on public.stock_transfers (transfer_no);

-- Not unique: every line of one dispatch carries the same key. The replay
-- check at the top of send_transfer is what stops a retry going out twice.
create index if not exists stock_transfers_idempotency_idx
  on public.stock_transfers (idempotency_key) where idempotency_key is not null;

-- One counter row per store per day, same shape as sale_ref_counters.
create table if not exists public.transfer_ref_counters (
  store_id   text not null,
  ref_date   date not null,
  last_seq   integer not null default 0,
  primary key (store_id, ref_date)
);

alter table public.transfer_ref_counters enable row level security;

create or replace function public.next_transfer_ref(p_store_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date := (now() at time zone 'Asia/Yangon')::date;
  v_seq  integer;
begin
  insert into public.transfer_ref_counters (store_id, ref_date, last_seq)
  values (p_store_id, v_date, 1)
  on conflict (store_id, ref_date)
  do update set last_seq = public.transfer_ref_counters.last_seq + 1
  returning last_seq into v_seq;

  return 'TR-' || replace(upper(p_store_id), '-', '')
         || '-' || to_char(v_date, 'YYMMDD')
         || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

create or replace function public.send_transfer(
  p_from_store      text,
  p_to_store        text,
  p_lines           jsonb,
  p_idempotency_key uuid default null
)
returns table (transfer_no text, line_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status      text;
  v_line        jsonb;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_qty         numeric;
  v_inv         public.store_inventory%rowtype;
  v_name        text;
  v_no          text;
  v_count       integer := 0;
  v_existing    text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.can_write_store(p_from_store) then
    raise exception 'You cannot send stock from %', p_from_store;
  end if;

  if p_from_store = p_to_store then
    raise exception 'Source and destination are the same store';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'No items to send';
  end if;

  -- A retried request must not dispatch twice.
  if p_idempotency_key is not null then
    select st.transfer_no into v_existing
    from public.stock_transfers st
    where st.idempotency_key = p_idempotency_key
    limit 1;

    if found then
      transfer_no := v_existing;
      select count(*) into line_count from public.stock_transfers
      where idempotency_key = p_idempotency_key;
      return next;
      return;
    end if;
  end if;

  -- -------------------------------------------------------------------
  -- Check every line against locked rows before moving anything. Locking
  -- here is what stops two dispatchers emptying the same shelf at once.
  -- -------------------------------------------------------------------
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    v_qty        := (v_line->>'qty')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity on one of the lines';
    end if;

    select * into v_inv
    from public.store_inventory si
    where si.store_id = p_from_store
      and si.product_id = v_product_id
      and si.variant_id is not distinct from v_variant_id
    for update;

    select coalesce(pv.variant_name, pr.name) into v_name
    from public.products pr
    left join public.product_variants pv on pv.id = v_variant_id
    where pr.id = v_product_id;

    if not found or v_inv.stock_qty is null then
      raise exception 'No stock record for % at %', coalesce(v_name, 'that item'), p_from_store;
    end if;

    if v_inv.stock_qty < v_qty then
      raise exception 'Insufficient stock for %: % available, % requested',
        coalesce(v_name, 'that item'), v_inv.stock_qty, v_qty;
    end if;
  end loop;

  -- A dispatch the warehouse starts itself is the one worth watching, so
  -- it waits at pending_approval unless the head is the one raising it.
  v_status := case
    when public.can_approve_dept('warehouse') then 'in_transit'
    else 'pending_approval'
  end;

  v_no := public.next_transfer_ref(p_from_store);

  -- Everything checked out; now move it.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    v_qty        := (v_line->>'qty')::numeric;

    select * into v_inv
    from public.store_inventory si
    where si.store_id = p_from_store
      and si.product_id = v_product_id
      and si.variant_id is not distinct from v_variant_id;

    update public.store_inventory
    set stock_qty = stock_qty - v_qty
    where store_id = p_from_store
      and product_id = v_product_id
      and variant_id is not distinct from v_variant_id;

    insert into public.stock_transfers (
      product_id, variant_id, from_store_id, to_store_id,
      qty, status, transferred_by, unit_cost, transfer_no, idempotency_key
    )
    values (
      v_product_id, v_variant_id, p_from_store, p_to_store,
      v_qty, v_status,
      (select email from public.profiles where id = auth.uid()),
      coalesce(v_inv.avg_cost, 0), v_no, p_idempotency_key
    );

    v_count := v_count + 1;
  end loop;

  insert into public.activity_log
    (entity_type, action, detail, actor, actor_id)
  values (
    'stock_transfer', 'sent',
    format('%s · %s lines · %s → %s', v_no, v_count, p_from_store, p_to_store),
    (select email from public.profiles where id = auth.uid()), auth.uid()
  );

  transfer_no := v_no;
  line_count  := v_count;
  return next;
end;
$$;

revoke all on function public.send_transfer(text, text, jsonb, uuid) from public, anon;
grant execute on function public.send_transfer(text, text, jsonb, uuid) to authenticated;

revoke all on function public.next_transfer_ref(text) from public, anon;
grant execute on function public.next_transfer_ref(text) to authenticated;
