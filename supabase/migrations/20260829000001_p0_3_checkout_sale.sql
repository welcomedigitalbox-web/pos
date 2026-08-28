-- P0-3: Atomic checkout. Replaces the browser's multi-statement sequence
-- (insert sale, insert items, per-line inventory update, batch loop) with
-- one transaction that locks stock, verifies availability, and is
-- idempotent on p_idempotency_key. Idempotent migration.

alter table public.sales add column if not exists idempotency_key uuid;

create unique index if not exists uq_sales_idempotency_key
  on public.sales (idempotency_key) where idempotency_key is not null;

create unique index if not exists uq_sales_sale_ref
  on public.sales (sale_ref) where sale_ref is not null;

create table if not exists public.sale_ref_counters (
  store_id text not null,
  ref_date date not null,
  next_seq integer not null default 1,
  primary key (store_id, ref_date)
);
alter table public.sale_ref_counters enable row level security;

create or replace function public.next_sale_ref(p_store_id text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_date date := (now() at time zone 'Asia/Yangon')::date;
  v_seq integer;
begin
  insert into public.sale_ref_counters (store_id, ref_date, next_seq)
  values (p_store_id, v_date, 2)
  on conflict (store_id, ref_date)
    do update set next_seq = public.sale_ref_counters.next_seq + 1
  returning next_seq - 1 into v_seq;
  return p_store_id || '-' || to_char(v_date, 'YYMMDD') || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

revoke all on function public.next_sale_ref(text) from public, anon;

create or replace function public.checkout_sale(
  p_idempotency_key uuid,
  p_store_id text,
  p_items jsonb,
  p_payment jsonb default '{}'::jsonb
)
returns table (sale_id uuid, sale_ref text, created_at timestamptz, replayed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing public.sales%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_variant_id uuid;
  v_qty numeric;
  v_unit_price numeric;
  v_avg_cost numeric;
  v_available numeric;
  v_inv_id uuid;
  v_subtotal numeric := 0;
  v_discount_amount numeric;
  v_vat_percent numeric;
  v_vat_amount numeric;
  v_grand_total numeric;
  v_amount_received numeric;
  v_advance numeric;
  v_change numeric;
  v_balance_due numeric;
  v_payment_method text;
  v_is_cod boolean;
  v_sale public.sales%rowtype;
  v_ref text;
  v_remaining numeric;
  v_deduct numeric;
  v_batch record;
  v_name text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_idempotency_key is null then raise exception 'idempotency key is required'; end if;
  if not public.can_write_store(p_store_id) then
    raise exception 'Not authorised to sell for store %', p_store_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Cart is empty';
  end if;

  select * into v_existing from public.sales where idempotency_key = p_idempotency_key;
  if found then
    sale_id := v_existing.id; sale_ref := v_existing.sale_ref;
    created_at := v_existing.created_at; replayed := true;
    return next; return;
  end if;

  perform 1 from public.store_inventory si
  where si.store_id = p_store_id
    and (si.product_id, coalesce(si.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) in (
      select (i->>'product_id')::uuid,
             coalesce(nullif(i->>'variant_id','')::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      from jsonb_array_elements(p_items) i)
  order by si.id for update;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := nullif(v_item->>'variant_id','')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    v_unit_price := (v_item->>'unit_price')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity for product %', v_product_id; end if;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'Invalid price for product %', v_product_id; end if;

    select si.stock_qty, si.avg_cost into v_available, v_avg_cost
    from public.store_inventory si
    where si.store_id = p_store_id and si.product_id = v_product_id
      and si.variant_id is not distinct from v_variant_id;

    if not found then
      raise exception 'No stock record for % in %', v_product_id, p_store_id; end if;

    if v_available < v_qty then
      select coalesce(pv.variant_name, p.name) into v_name
      from public.products p
      left join public.product_variants pv on pv.id = v_variant_id
      where p.id = v_product_id;
      raise exception 'Insufficient stock for %: % available, % requested',
        coalesce(v_name, v_product_id::text), v_available, v_qty;
    end if;

    v_subtotal := v_subtotal + (v_qty * v_unit_price);
  end loop;

  v_payment_method := coalesce(p_payment->>'payment_method', 'cash');
  v_discount_amount := coalesce((p_payment->>'discount_amount')::numeric, 0);
  v_vat_percent := coalesce((p_payment->>'vat_percent')::numeric, 0);

  if v_discount_amount < 0 or v_discount_amount > v_subtotal then
    raise exception 'Discount of % is not valid for a subtotal of %', v_discount_amount, v_subtotal;
  end if;

  if v_discount_amount > 0
     and coalesce(p_payment->>'discount_approved_by','') = ''
     and not public.is_approver_role(public.my_role()) then
    raise exception 'This discount needs approval';
  end if;

  v_vat_amount := round((v_subtotal - v_discount_amount) * v_vat_percent / 100.0, 2);
  v_grand_total := v_subtotal - v_discount_amount + v_vat_amount;
  v_is_cod := coalesce((p_payment->>'is_cod')::boolean, false);
  v_advance := coalesce((p_payment->>'advance_payment')::numeric, 0);
  v_amount_received := coalesce((p_payment->>'amount_received')::numeric, v_grand_total);

  if v_is_cod then
    v_change := greatest(v_advance - v_grand_total, 0);
    v_balance_due := greatest(v_grand_total - v_advance, 0);
  else
    v_change := greatest(v_amount_received - v_grand_total, 0);
    v_balance_due := 0;
  end if;

  v_ref := public.next_sale_ref(p_store_id);

  insert into public.sales (
    idempotency_key, sale_ref, store_id, cashier, cashier_email,
    total, subtotal, payment_method, discount_type, discount_value,
    discount_amount, discount_approved_by, discount_approved_at,
    vat_percent, vat_amount, amount_received, change_amount,
    advance_payment, balance_due, note, customer_id, customer_name,
    sale_rep_id, sale_rep_name, order_type, channel, delivery_address)
  values (
    p_idempotency_key, v_ref, p_store_id, 'POS',
    (select email from public.profiles where id = auth.uid()),
    v_grand_total, v_subtotal, v_payment_method,
    p_payment->>'discount_type',
    coalesce((p_payment->>'discount_value')::numeric, 0),
    v_discount_amount,
    nullif(p_payment->>'discount_approved_by',''),
    case when coalesce(p_payment->>'discount_approved_by','') <> '' then now() else null end,
    v_vat_percent, v_vat_amount,
    case when v_is_cod then v_grand_total else v_amount_received end,
    v_change,
    case when v_is_cod then v_advance else 0 end,
    v_balance_due,
    nullif(p_payment->>'note',''),
    nullif(p_payment->>'customer_id','')::uuid,
    nullif(p_payment->>'customer_name',''),
    nullif(p_payment->>'sale_rep_id','')::uuid,
    nullif(p_payment->>'sale_rep_name',''),
    nullif(p_payment->>'order_type',''),
    nullif(p_payment->>'channel',''),
    nullif(p_payment->>'delivery_address',''))
  returning * into v_sale;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := nullif(v_item->>'variant_id','')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    v_unit_price := (v_item->>'unit_price')::numeric;

    select si.id, si.stock_qty, si.avg_cost into v_inv_id, v_available, v_avg_cost
    from public.store_inventory si
    where si.store_id = p_store_id and si.product_id = v_product_id
      and si.variant_id is not distinct from v_variant_id;

    insert into public.sale_items (
      sale_id, product_id, variant_id, product_name,
      qty, unit_price, line_total, unit_cost, line_cogs)
    values (
      v_sale.id, v_product_id, v_variant_id,
      coalesce(v_item->>'product_name',''),
      v_qty, v_unit_price, v_qty * v_unit_price,
      v_avg_cost, v_avg_cost * v_qty);

    update public.store_inventory
    set stock_qty = stock_qty - v_qty, updated_at = now()
    where id = v_inv_id;

    v_remaining := v_qty;
    for v_batch in
      select sp.id, sp.remaining_qty from public.stock_purchases sp
      where sp.store_id = p_store_id and sp.product_id = v_product_id
        and sp.variant_id is not distinct from v_variant_id
        and sp.remaining_qty > 0
      order by sp.expiry_date asc nulls last, sp.created_at asc
      for update
    loop
      exit when v_remaining <= 0;
      v_deduct := least(v_batch.remaining_qty, v_remaining);
      update public.stock_purchases set remaining_qty = remaining_qty - v_deduct
      where id = v_batch.id;
      v_remaining := v_remaining - v_deduct;
    end loop;
  end loop;

  insert into public.activity_log (entity_type, entity_id, action, detail, actor, actor_id)
  values ('sale', v_sale.id, 'checkout',
    format('%s, %s lines, total %s', v_ref, jsonb_array_length(p_items), v_grand_total),
    (select email from public.profiles where id = auth.uid()), auth.uid());

  sale_id := v_sale.id; sale_ref := v_sale.sale_ref;
  created_at := v_sale.created_at; replayed := false;
  return next;
end;
$$;

revoke all on function public.checkout_sale(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.checkout_sale(uuid, text, jsonb, jsonb) to authenticated;

update public.sales set sale_ref = 'LEGACY-' || upper(substring(id::text, 1, 8))
where sale_ref is null;

create index if not exists idx_stock_purchases_fefo
  on public.stock_purchases (store_id, product_id, variant_id, expiry_date, created_at)
  where remaining_qty > 0;
