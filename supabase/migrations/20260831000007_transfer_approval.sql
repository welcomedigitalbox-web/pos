-- =====================================================================
-- Transfer sign-off
-- Repo path: supabase/migrations/20260831000007_transfer_approval.sql
--
-- Two routes put goods on a van, and only one of them was signed for:
--
--   a store asks -> sale manager approves -> warehouse picks and sends
--   the warehouse decides by itself -> goods leave
--
-- The second is the one worth watching, so send_transfer (amended in
-- 20260830000001) now files it at 'pending_approval' unless the warehouse
-- head is the one raising it. The stock still comes off the moment the
-- transfer is raised: the goods are set aside for that branch and must
-- not be promised to another. Rejecting puts them back.
--
-- The request-inbox route is untouched - it inserts its rows directly and
-- already carries the sale manager's approval on the request behind it.
-- =====================================================================

alter table public.stock_transfers drop constraint if exists stock_transfers_status_check;
alter table public.stock_transfers add constraint stock_transfers_status_check check (
  status = any (array[
    'in_transit', 'received', 'discrepancy',
    'pending_approval', 'resolved', 'rejected'
  ])
);

alter table public.stock_transfers
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text;

create index if not exists idx_stock_transfers_status on public.stock_transfers (status);

create or replace function public.approve_transfer(
  p_transfer_no text,
  p_reject boolean default false,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text; v_from text; v_count integer; v_row record;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  select from_store_id into v_from
  from public.stock_transfers
  where transfer_no = p_transfer_no and status = 'pending_approval'
  limit 1;

  if v_from is null then
    raise exception 'nothing awaiting approval under %', p_transfer_no;
  end if;

  if not public.can_approve_dept('warehouse') then
    raise exception 'only the warehouse head can release a transfer';
  end if;

  -- Goods that are not going anywhere belong back on the shelf they
  -- were set aside from.
  if p_reject then
    for v_row in
      select product_id, variant_id, qty
      from public.stock_transfers
      where transfer_no = p_transfer_no and status = 'pending_approval'
    loop
      update public.store_inventory
      set stock_qty = stock_qty + v_row.qty
      where store_id = v_from
        and product_id = v_row.product_id
        and variant_id is not distinct from v_row.variant_id;
    end loop;
  end if;

  update public.stock_transfers
  set status = case when p_reject then 'rejected' else 'in_transit' end,
      approved_by = case when p_reject then approved_by else v_actor end,
      approved_at = case when p_reject then approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      reject_reason = case when p_reject then p_reason else reject_reason end
  where transfer_no = p_transfer_no and status = 'pending_approval';

  get diagnostics v_count = row_count;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type)
  values (v_actor, auth.uid(),
    case when p_reject then 'transfer_rejected' else 'transfer_released' end,
    format('%s · %s · %s', p_transfer_no, v_from, coalesce(p_reason, '')),
    'stock_transfer');

  return v_count;
end;
$$;

revoke all on function public.approve_transfer(text, boolean, text) from public, anon;
grant execute on function public.approve_transfer(text, boolean, text) to authenticated;
