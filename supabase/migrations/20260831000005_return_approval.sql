-- =====================================================================
-- Sale return sign-off
-- Repo path: supabase/migrations/20260831000005_return_approval.sql
--
-- Approving a refund already does several things at once: it may open a
-- transfer back to the selling store, may raise an inter-store
-- settlement, and puts saleable stock back on the shelf. Those steps
-- live in the page and work; what was missing is the check on who is
-- allowed to press the button.
--
-- So this pair of functions decides and records the sign-off, and leaves
-- the rest where it is. They are the only route that can set a return to
-- approved or rejected, because the policy below no longer lets a plain
-- UPDATE touch those columns.
--
-- One approver: the sale manager who covers the store whose books carry
-- the refund. Directors override.
--
-- Idempotent - safe to re-run.
-- =====================================================================

alter table public.sale_returns
  add column if not exists rejected_by text,
  add column if not exists rejected_at timestamptz;

create or replace function public.approve_sale_return(
  p_return_id uuid,
  p_reject boolean default false,
  p_reason text default null
)
returns public.sale_returns
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ret public.sale_returns;
  v_actor text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then
    raise exception 'not signed in';
  end if;

  select * into v_ret from public.sale_returns
  where id = p_return_id
  for update;

  if not found then
    raise exception 'return not found';
  end if;

  if v_ret.status <> 'pending' then
    raise exception 'this return is already %', v_ret.status;
  end if;

  -- The refund lands on the selling store's books, so its sale manager is
  -- the one who answers for it - not the branch that happened to take the
  -- goods back over the counter.
  if not (
    public.can_approve_for_email(v_ret.requested_by)
    or public.can_approve_dept('sale', v_ret.store_id)
  ) then
    raise exception 'you are not the approver for this return';
  end if;

  update public.sale_returns
  set status = case when p_reject then 'rejected' else 'approved' end,
      approved_by = v_actor,
      approved_at = case when p_reject then approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      rejected_reason = case when p_reject then p_reason else rejected_reason end
  where id = p_return_id
  returning * into v_ret;

  insert into public.activity_log (actor, actor_id, action, detail, entity_type, entity_id)
  values (
    v_actor, auth.uid(),
    case when p_reject then 'sale_return_rejected' else 'sale_return_approved' end,
    format('%s · %s · %s', coalesce(v_ret.return_number, ''), v_ret.store_id, coalesce(p_reason, '')),
    'sale_return', p_return_id
  );

  return v_ret;
end;
$$;

revoke all on function public.approve_sale_return(uuid, boolean, text) from public, anon;
grant execute on function public.approve_sale_return(uuid, boolean, text) to authenticated;
