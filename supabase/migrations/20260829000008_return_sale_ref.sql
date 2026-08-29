-- =====================================================================
-- Returns carry the receipt reference they were filed against
-- Repo path: supabase/migrations/20260829000008_return_sale_ref.sql
--
-- Joining sales for the reference does not work: RLS scopes that table, so
-- a branch processing another store's return reads null. Copying the value
-- at creation keeps it visible wherever the return is shown.
--
-- submit_sale_return is recreated here so it writes the column.
--
-- Applied by hand in the SQL editor first; repair history if push conflicts.
-- Idempotent - safe to re-run.
-- =====================================================================

alter table public.sale_returns
  add column if not exists sale_ref text;

update public.sale_returns r
set sale_ref = s.sale_ref
from public.sales s
where s.id = r.original_sale_id and r.sale_ref is null;

create or replace function public.submit_sale_return(
  p_sale_id uuid, p_lines jsonb, p_refund_method text,
  p_refund_payment text default null, p_voucher_url text default null,
  p_reason text default null, p_idempotency_key uuid default null
)
returns table (return_id uuid, return_number text, refund_amount numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale        public.sales%rowtype;
  v_my_store    text;
  v_line        jsonb;
  v_product_id  uuid;
  v_variant_id  uuid;
  v_qty         numeric;
  v_condition   text;
  v_bought      numeric;
  v_returned    numeric;
  v_item        public.sale_items%rowtype;
  v_unit_net    numeric;
  v_refund      numeric := 0;
  v_return      public.sale_returns%rowtype;
  v_number      text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_my_store := public.my_store_id();

  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'Sale not found';
  end if;

  -- Global roles have no single store; they process where the sale was made.
  if v_my_store is null then
    if not public.is_global_writer() then
      raise exception 'No store assigned to your account';
    end if;
    v_my_store := v_sale.store_id;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'No items selected';
  end if;

  -- -------------------------------------------------------------------
  -- Validate every line against the original sale before writing.
  -- -------------------------------------------------------------------
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    v_qty        := (v_line->>'qty')::numeric;
    v_condition  := coalesce(v_line->>'condition', 'good');

    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid return quantity';
    end if;
    if v_condition not in ('good', 'damaged') then
      raise exception 'Invalid condition %', v_condition;
    end if;

    select * into v_item
    from public.sale_items si
    where si.sale_id = p_sale_id
      and si.product_id = v_product_id
      and si.variant_id is not distinct from v_variant_id
    limit 1;

    if not found then
      raise exception 'That item is not on this sale';
    end if;

    v_bought := v_item.qty;

    select coalesce(sum(ri.qty), 0) into v_returned
    from public.sale_return_items ri
    join public.sale_returns r on r.id = ri.return_id
    where r.original_sale_id = p_sale_id
      and r.status <> 'rejected'
      and ri.line_type = 'return'
      and ri.product_id = v_product_id
      and ri.variant_id is not distinct from v_variant_id;

    if v_qty + v_returned > v_bought then
      raise exception 'Only % of % left to return for %',
        v_bought - v_returned, v_bought, v_item.product_name;
    end if;

    -- Refund what was actually paid: the line's share after any order-level
    -- discount, never the pre-discount price.
    v_unit_net := case
      when coalesce(v_sale.subtotal, 0) > 0 and coalesce(v_sale.discount_amount, 0) > 0
        then (v_item.line_total - v_sale.discount_amount * (v_item.line_total / v_sale.subtotal)) / v_item.qty
      else v_item.unit_price
    end;

    v_refund := v_refund + round(v_unit_net * v_qty, 2);
  end loop;

  v_number := 'RT-' || to_char(now() at time zone 'Asia/Yangon', 'YYMMDD')
              || '-' || lpad((floor(random() * 9999) + 1)::int::text, 4, '0');

  insert into public.sale_returns (
    return_number, original_sale_id, sale_ref, store_id, processed_store_id,
    customer_id, customer_name, refund_method, refund_payment_method,
    refund_amount, status, reason, voucher_url, requested_by
  )
  values (
    v_number, p_sale_id, v_sale.sale_ref,
    v_sale.store_id,      -- the selling branch owns the goods
    v_my_store,           -- where the customer actually walked in
    v_sale.customer_id, v_sale.customer_name,
    coalesce(p_refund_method, 'cash'),
    nullif(p_refund_payment, ''),
    v_refund, 'pending',
    nullif(p_reason, ''), nullif(p_voucher_url, ''),
    (select email from public.profiles where id = auth.uid())
  )
  returning * into v_return;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    v_qty        := (v_line->>'qty')::numeric;
    v_condition  := coalesce(v_line->>'condition', 'good');

    select * into v_item
    from public.sale_items si
    where si.sale_id = p_sale_id
      and si.product_id = v_product_id
      and si.variant_id is not distinct from v_variant_id
    limit 1;

    v_unit_net := case
      when coalesce(v_sale.subtotal, 0) > 0 and coalesce(v_sale.discount_amount, 0) > 0
        then (v_item.line_total - v_sale.discount_amount * (v_item.line_total / v_sale.subtotal)) / v_item.qty
      else v_item.unit_price
    end;

    insert into public.sale_return_items (
      return_id, product_id, variant_id, product_name,
      qty, unit_price, unit_cogs, condition, line_type
    )
    values (
      v_return.id, v_product_id, v_variant_id, v_item.product_name,
      v_qty, v_unit_net, coalesce(v_item.unit_cost, 0), v_condition, 'return'
    );
  end loop;

  insert into public.activity_log
    (entity_type, entity_id, action, detail, actor, actor_id)
  values (
    'sale_return', v_return.id, 'requested',
    format('%s against %s%s', v_number, v_sale.sale_ref,
           case when v_my_store <> v_sale.store_id
                then ' (processed at ' || v_my_store || ')' else '' end),
    (select email from public.profiles where id = auth.uid()), auth.uid()
  );

  return_id     := v_return.id;
  return_number := v_return.return_number;
  refund_amount := v_return.refund_amount;
  return next;
end;
$$;

revoke all on function public.submit_sale_return(uuid, jsonb, text, text, text, text, uuid)
  from public, anon;
grant execute on function public.submit_sale_return(uuid, jsonb, text, text, text, text, uuid)
  to authenticated;
