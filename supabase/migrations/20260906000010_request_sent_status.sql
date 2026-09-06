-- =====================================================================
-- Picking closes a line
-- Repo path: supabase/migrations/20260906000010_request_sent_status.sql
--
-- Sending wrote received_qty and left the line at 'approved', so it stayed
-- in the To Send queue and could be picked again - and again - each time
-- taking more stock off the warehouse for a request that had already been
-- filled.
--
-- A picked line now moves to 'sent'. It leaves the queue but does not
-- claim to have arrived: 'received' belongs to the shop, when it confirms
-- the delivery under Incoming Transfers.
--
-- Lines are separate rows, so this is per line. A request whose first
-- product has gone and whose second has not shows one line sent and one
-- still waiting, which is what the warehouse floor actually looks like.
--
-- Idempotent - safe to re-run.
-- =====================================================================

alter table public.stock_requests drop constraint if exists stock_requests_status_check;
alter table public.stock_requests add constraint stock_requests_status_check check (
  status in (
    'awaiting_approval', 'pending', 'approved', 'sent',
    'received', 'mismatch', 'rejected', 'cancelled'
  )
);

-- ---------------------------------------------------------------------
-- Recording the pick
--
-- The transfer insert and the inventory move stay in the page for now;
-- what this guarantees is that a line cannot be picked twice, because the
-- status check and the update happen under one lock.
-- ---------------------------------------------------------------------

create or replace function public.mark_request_sent(
  p_request_id uuid,
  p_qty numeric
)
returns public.stock_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.stock_requests;
  v_actor text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then
    raise exception 'not signed in';
  end if;

  select * into v_req from public.stock_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'request not found';
  end if;

  -- Second press of the button, or two pickers on the same line.
  if v_req.status <> 'approved' then
    raise exception 'this line is % and has left the picking queue', v_req.status;
  end if;

  if not public.can_read_store(v_req.requested_warehouse_id) then
    raise exception 'you do not work this warehouse';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'quantity must be positive';
  end if;

  update public.stock_requests
  set status = 'sent',
      received_qty = p_qty
  where id = p_request_id
  returning * into v_req;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type, entity_id)
  values (
    v_actor, auth.uid(), 'stock_request_sent',
    format('%s · %s · %s', coalesce(v_req.request_no, ''), v_req.store_id, p_qty),
    'stock_request', p_request_id
  );

  return v_req;
end;
$$;

revoke all on function public.mark_request_sent(uuid, numeric) from public, anon;
grant execute on function public.mark_request_sent(uuid, numeric) to authenticated;
