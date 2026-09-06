-- =====================================================================
-- Undoing a warehouse acceptance
-- Repo path: supabase/migrations/20260906000008_unapprove_request.sql
--
-- Accepting a request is a judgement made against the shelf as it looked
-- at that moment. Stock moves, a bigger order lands, someone approves the
-- wrong line - and the head needs to put it back rather than reject it and
-- make the shop start again.
--
-- This only walks back the warehouse stage: approved returns to pending,
-- where it waits on the head again. The sale manager's approval behind it
-- stands, because nothing about the shop's need has changed.
--
-- Once anything has been picked against the request there is stock in
-- transit, and the way back from there is a return, not an undo - so a
-- request with a received quantity is refused.
--
-- Idempotent - safe to re-run.
-- =====================================================================

create or replace function public.unapprove_stock_request(
  p_request_id uuid,
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

  if v_req.status <> 'approved' then
    raise exception 'this request is % and cannot be put back', v_req.status;
  end if;

  if coalesce(v_req.received_qty, 0) > 0 then
    raise exception 'stock has already gone out against this request';
  end if;

  if not public.can_approve_dept('warehouse') then
    raise exception 'only the warehouse head can undo an acceptance';
  end if;

  update public.stock_requests
  set status = 'pending',
      warehouse_approved_by = null,
      warehouse_approved_at = null
  where id = p_request_id
  returning * into v_req;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type, entity_id)
  values (
    v_actor, auth.uid(), 'stock_request_wh_undone',
    format('%s · %s · %s', coalesce(v_req.request_no, ''), v_req.store_id, coalesce(p_reason, '')),
    'stock_request', p_request_id
  );

  return v_req;
end;
$$;

revoke all on function public.unapprove_stock_request(uuid, text) from public, anon;
grant execute on function public.unapprove_stock_request(uuid, text) to authenticated;
