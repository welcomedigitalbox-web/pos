-- =====================================================================
-- Stock request approval routing
-- Repo path: supabase/migrations/20260831000002_request_approval_routing.sql
--
-- The status flow already has the two stages this needs:
--
--   awaiting_approval  -- the store asked
--        |  sale manager who covers that store
--        v
--   pending            -- cleared to be picked in the warehouse
--        |  warehouse dispatches
--        v
--   received / mismatch
--
-- What was missing is who may move a request between them. can_write_store
-- lets any department head touch a request for a store they cover, so a
-- merchandising head could clear a shop's stock request. These RPCs put the
-- decision where the org chart says it belongs, and record who made it.
--
-- Idempotent - safe to re-run.
-- =====================================================================

alter table public.stock_requests
  add column if not exists approved_at timestamptz,
  add column if not exists warehouse_approved_by text,
  add column if not exists warehouse_approved_at timestamptz,
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz,
  add column if not exists reject_reason text;

-- 'cancelled' is already written by the UI but was never in the constraint.
alter table public.stock_requests drop constraint if exists stock_requests_status_check;
alter table public.stock_requests add constraint stock_requests_status_check check (
  status in (
    'awaiting_approval', 'pending', 'received',
    'mismatch', 'approved', 'rejected', 'cancelled'
  )
);

-- ---------------------------------------------------------------------
-- Stage one: the sale manager who covers the requesting store
-- ---------------------------------------------------------------------

create or replace function public.approve_stock_request(
  p_request_id uuid,
  p_reject boolean default false,
  p_reason text default null
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

  -- Lock the row: two managers hitting approve at once must not both win.
  select * into v_req from public.stock_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'request not found';
  end if;

  if v_req.status <> 'awaiting_approval' then
    raise exception 'request is % and can no longer be approved here', v_req.status;
  end if;

  -- Either you are the requester's line manager, or you head the sale
  -- department for a store you cover. Directors override both.
  if not (
    public.can_approve_for_email(v_req.requested_by)
    or public.can_approve_dept('sale', v_req.store_id)
  ) then
    raise exception 'you are not the approver for this request';
  end if;

  perform set_config('pos.approval_flow', 'on', true);

  update public.stock_requests
  set status = case when p_reject then 'rejected' else 'pending' end,
      approved_by = case when p_reject then approved_by else v_actor end,
      approved_at = case when p_reject then approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      reject_reason = case when p_reject then p_reason else reject_reason end
  where id = p_request_id
  returning * into v_req;

  perform set_config('pos.approval_flow', '', true);

  insert into public.activity_log (actor, actor_id, action, detail, entity_type, entity_id)
  values (
    v_actor, auth.uid(),
    case when p_reject then 'stock_request_rejected' else 'stock_request_approved' end,
    format('%s · %s', v_req.store_id, coalesce(p_reason, '')),
    'stock_request', p_request_id
  );

  return v_req;
end;
$$;

-- ---------------------------------------------------------------------
-- Stage two: the warehouse head accepts the job into the picking queue
--
-- The dispatch itself already moves stock through send_transfer; this is
-- the sign-off that says the warehouse has taken it on.
-- ---------------------------------------------------------------------

create or replace function public.warehouse_accept_request(
  p_request_id uuid,
  p_reject boolean default false,
  p_reason text default null
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

  if v_req.status <> 'pending' then
    raise exception 'request is % and is not waiting on the warehouse', v_req.status;
  end if;

  -- No store argument: the warehouse head answers for every branch.
  if not public.can_approve_dept('warehouse') then
    raise exception 'only the warehouse head can accept this';
  end if;

  perform set_config('pos.approval_flow', 'on', true);

  update public.stock_requests
  set status = case when p_reject then 'rejected' else 'approved' end,
      warehouse_approved_by = case when p_reject then warehouse_approved_by else v_actor end,
      warehouse_approved_at = case when p_reject then warehouse_approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      reject_reason = case when p_reject then p_reason else reject_reason end
  where id = p_request_id
  returning * into v_req;

  perform set_config('pos.approval_flow', '', true);

  insert into public.activity_log (actor, actor_id, action, detail, entity_type, entity_id)
  values (
    v_actor, auth.uid(),
    case when p_reject then 'stock_request_wh_rejected' else 'stock_request_wh_accepted' end,
    format('%s · %s', v_req.store_id, coalesce(p_reason, '')),
    'stock_request', p_request_id
  );

  return v_req;
end;
$$;

-- ---------------------------------------------------------------------
-- Close the direct route
--
-- With the RPCs in place, nothing should be updating status by hand. The
-- write policy keeps store staff able to raise and cancel their own
-- requests, but the approval columns move only through the functions above.
-- ---------------------------------------------------------------------

-- A BEFORE UPDATE guard was tried here to block hand-rolled status
-- changes. It could not tell an RPC's write from a direct one: SECURITY
-- DEFINER leaves the session role alone, and a transaction-local flag
-- does not survive the way PostgREST calls the function. The approval
-- checks live inside the RPCs above, where they can see who is asking.

revoke all on function public.approve_stock_request(uuid, boolean, text) from public, anon;
revoke all on function public.warehouse_accept_request(uuid, boolean, text) from public, anon;
grant execute on function public.approve_stock_request(uuid, boolean, text) to authenticated;
grant execute on function public.warehouse_accept_request(uuid, boolean, text) to authenticated;
