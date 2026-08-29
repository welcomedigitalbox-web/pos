-- =====================================================================
-- Cross-store return lookup
-- Repo path: supabase/migrations/20260829000004_lookup_sale_for_return.sql
--
-- P0-2 scoped `sales` to the cashier's own store, which is right for
-- browsing but broke the one case where a cashier legitimately needs
-- another branch's sale: a customer walks into SR-B with a receipt from
-- SR-A and wants a refund.
--
-- This RPC allows lookup, not browsing. The caller must already hold the
-- exact sale_ref printed on the receipt - there is no search, no partial
-- match, no listing. Every lookup is logged, so a cashier fishing for
-- other branches' takings leaves a trail.
--
-- Idempotent - safe to re-run.
-- =====================================================================

create or replace function public.lookup_sale_for_return(p_sale_ref text)
returns table (
  sale_id        uuid,
  sale_ref       text,
  store_id       text,
  created_at     timestamptz,
  total          numeric,
  subtotal       numeric,
  discount_amount numeric,
  customer_id    uuid,
  customer_name  text,
  payment_method text,
  cashier_email  text,
  items          jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale public.sales%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_sale_ref is null or btrim(p_sale_ref) = '' then
    raise exception 'A receipt reference is required';
  end if;

  -- Exact match only. Case-insensitive because receipts are read aloud and
  -- retyped, but never a prefix or wildcard.
  select * into v_sale
  from public.sales s
  where upper(s.sale_ref) = upper(btrim(p_sale_ref))
  limit 1;

  if not found then
    raise exception 'No sale found with reference %', p_sale_ref;
  end if;

  insert into public.activity_log
    (entity_type, entity_id, action, detail, actor, actor_id)
  values (
    'sale', v_sale.id, 'return_lookup',
    format('%s (%s) looked up from another store', v_sale.sale_ref, v_sale.store_id),
    (select email from public.profiles where id = auth.uid()), auth.uid()
  );

  sale_id         := v_sale.id;
  sale_ref        := v_sale.sale_ref;
  store_id        := v_sale.store_id;
  created_at      := v_sale.created_at;
  total           := v_sale.total;
  subtotal        := v_sale.subtotal;
  discount_amount := v_sale.discount_amount;
  customer_id     := v_sale.customer_id;
  customer_name   := v_sale.customer_name;
  payment_method  := v_sale.payment_method;
  cashier_email   := v_sale.cashier_email;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', si.id,
           'product_id', si.product_id,
           'variant_id', si.variant_id,
           'product_name', si.product_name,
           'qty', si.qty,
           'unit_price', si.unit_price,
           'line_total', si.line_total,
           'unit_cost', si.unit_cost
         ) order by si.created_at), '[]'::jsonb)
    into items
  from public.sale_items si
  where si.sale_id = v_sale.id;

  return next;
end;
$$;

revoke all on function public.lookup_sale_for_return(text) from public, anon;
grant execute on function public.lookup_sale_for_return(text) to authenticated;

-- Returns already filed against a sale, so the till can refuse a second
-- refund for the same line. Same rule: exact reference, no browsing.
create or replace function public.returned_qty_for_sale(p_sale_id uuid)
returns table (product_id uuid, variant_id uuid, returned_qty numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ri.product_id, ri.variant_id, sum(ri.qty)
  from public.sale_return_items ri
  join public.sale_returns r on r.id = ri.return_id
  where r.original_sale_id = p_sale_id
    and r.status <> 'rejected'
    and ri.line_type = 'return'
  group by ri.product_id, ri.variant_id;
$$;

revoke all on function public.returned_qty_for_sale(uuid) from public, anon;
grant execute on function public.returned_qty_for_sale(uuid) to authenticated;
