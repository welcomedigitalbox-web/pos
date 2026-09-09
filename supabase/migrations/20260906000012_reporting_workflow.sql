-- =====================================================================
-- Reports: what happens after they are filed
-- Repo path: supabase/migrations/20260906000012_reporting_workflow.sql
--
-- Three things the first schema left out:
--
-- Routing. A shop assistant hears a customer ask for something the shop
-- does not stock. That belongs to merchandising, but the assistant only
-- knows to write it down. So a report can raise an incident and tick the
-- departments it concerns, and it appears on their dashboard. The ticks
-- are not restricted - anyone may tick anyone - because the person
-- closest to the fact is rarely the person who knows the org chart. A
-- manager or the owner can route it on later if the ticks were wrong.
--
-- Corrections. Staff delete nothing. A mistake becomes a cancel request;
-- a change to an approved report becomes an edit request. Both go to the
-- manager, and the report moves to archived or back to draft. What was
-- filed stays on the record either way.
--
-- Acknowledgement. Manager approval sends a report up to the owner, who
-- marks it done per department - the point being that the owner has read
-- warehouse's report, not that some reports arrived that day.
--
-- Idempotent - safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Status: the two requests, and the owner's sign-off
-- ---------------------------------------------------------------------

alter table reporting.submissions drop constraint if exists submissions_status_check;
alter table reporting.submissions add constraint submissions_status_check check (
  status in (
    'draft',            -- being written, or sent back
    'submitted',        -- waiting on the manager
    'approved',         -- manager signed it, now with the owner
    'acknowledged',     -- owner has read it
    'rejected',         -- sent back with a reason
    'cancel_requested', -- filed by mistake, waiting on the manager
    'edit_requested',   -- approved but wrong, waiting on the manager
    'archived'          -- cancelled and kept
  )
);

alter table reporting.submissions
  add column if not exists acknowledged_by text,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists request_reason text,
  add column if not exists requested_by text,
  add column if not exists requested_at timestamptz;

create index if not exists idx_submissions_ack
  on reporting.submissions (status, report_date desc)
  where status in ('approved', 'acknowledged');

-- ---------------------------------------------------------------------
-- 2. Incidents raised from a report
-- ---------------------------------------------------------------------

create table if not exists reporting.incidents (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references reporting.submissions(id) on delete cascade,
  title         text not null,
  detail        text,
  -- What the person filing it thinks it needs. Not a workflow state -
  -- each department that receives it answers for itself below.
  urgency       text not null default 'normal'
                check (urgency in ('normal', 'attention', 'critical')),
  evidence      text,
  raised_by     text not null,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  closed_by     text
);

create index if not exists idx_incidents_submission on reporting.incidents (submission_id);
create index if not exists idx_incidents_open on reporting.incidents (created_at desc)
  where closed_at is null;

-- One row per department the incident was sent to. A return order that
-- concerns both accounts and the warehouse gets two, and each answers
-- separately - one department acting is not the other having seen it.
create table if not exists reporting.incident_routes (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references reporting.incidents(id) on delete cascade,
  department    public.department not null,
  routed_by     text not null,
  routed_at     timestamptz not null default now(),
  seen_by       text,
  seen_at       timestamptz,
  response      text,
  responded_at  timestamptz,
  unique (incident_id, department)
);

create index if not exists idx_routes_department
  on reporting.incident_routes (department, routed_at desc);

-- What a department sees on its dashboard: everything sent to it that it
-- has not answered yet, newest first.
create or replace view reporting.incident_inbox as
select
  r.id            as route_id,
  r.department,
  r.routed_at,
  r.seen_at,
  r.response,
  i.id            as incident_id,
  i.title,
  i.detail,
  i.urgency,
  i.evidence,
  i.raised_by,
  i.closed_at,
  s.form_id,
  s.store_id,
  s.report_date
from reporting.incident_routes r
join reporting.incidents i on i.id = r.incident_id
join reporting.submissions s on s.id = i.submission_id;

-- ---------------------------------------------------------------------
-- 3. Raising and routing
-- ---------------------------------------------------------------------

create or replace function reporting.raise_incident(
  p_submission_id uuid,
  p_title text,
  p_detail text default null,
  p_urgency text default 'normal',
  p_departments text[] default '{}',
  p_evidence text default null
)
returns uuid
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_actor text;
  v_id uuid;
  v_dept text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  if coalesce(p_title, '') = '' then
    raise exception 'an incident needs a title';
  end if;

  perform 1 from reporting.submissions where id = p_submission_id;
  if not found then raise exception 'report not found'; end if;

  insert into reporting.incidents
    (submission_id, title, detail, urgency, evidence, raised_by)
  values (p_submission_id, p_title, p_detail, p_urgency, p_evidence, v_actor)
  returning id into v_id;

  foreach v_dept in array p_departments loop
    insert into reporting.incident_routes (incident_id, department, routed_by)
    values (v_id, v_dept::public.department, v_actor)
    on conflict do nothing;
  end loop;

  return v_id;
end;
$$;

-- Sending it on: a manager or the owner adds the department the person
-- filing it did not think of.
create or replace function reporting.route_incident(
  p_incident_id uuid,
  p_department text
)
returns void
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_actor text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  -- Routing on is a supervisory act; the original ticks are not.
  if not (public.is_director() or public.is_dept_head()) then
    raise exception 'only a manager can send this on';
  end if;

  insert into reporting.incident_routes (incident_id, department, routed_by)
  values (p_incident_id, p_department::public.department, v_actor)
  on conflict do nothing;
end;
$$;

create or replace function reporting.respond_incident(
  p_route_id uuid,
  p_response text
)
returns void
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_actor text;
  v_dept public.department;
  v_my_dept text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  select department into v_dept from reporting.incident_routes where id = p_route_id;
  if v_dept is null then raise exception 'not found'; end if;

  v_my_dept := public.my_department();
  if v_my_dept is distinct from v_dept::text and not public.is_director() then
    raise exception 'this was sent to %, not to you', v_dept;
  end if;

  update reporting.incident_routes
  set response = p_response,
      responded_at = now(),
      seen_by = coalesce(seen_by, v_actor),
      seen_at = coalesce(seen_at, now())
  where id = p_route_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Cancel and edit requests
-- ---------------------------------------------------------------------

create or replace function reporting.request_cancel(
  p_submission_id uuid,
  p_reason text
)
returns reporting.submissions
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_sub reporting.submissions;
  v_actor text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;
  if coalesce(p_reason, '') = '' then
    raise exception 'say why it should be cancelled';
  end if;

  select * into v_sub from reporting.submissions where id = p_submission_id for update;
  if not found then raise exception 'report not found'; end if;
  if v_sub.created_by <> v_actor and not public.is_director() then
    raise exception 'this is not your report';
  end if;
  if v_sub.status not in ('submitted', 'approved') then
    raise exception 'a % report cannot be cancelled', v_sub.status;
  end if;

  update reporting.submissions
  set status = 'cancel_requested',
      request_reason = p_reason,
      requested_by = v_actor,
      requested_at = now()
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

-- Once the manager has signed a report, changing it needs their consent
-- again - otherwise the signature is on something that no longer exists.
create or replace function reporting.request_edit(
  p_submission_id uuid,
  p_reason text
)
returns reporting.submissions
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_sub reporting.submissions;
  v_actor text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;
  if coalesce(p_reason, '') = '' then
    raise exception 'say what needs changing';
  end if;

  select * into v_sub from reporting.submissions where id = p_submission_id for update;
  if not found then raise exception 'report not found'; end if;
  if v_sub.created_by <> v_actor and not public.is_director() then
    raise exception 'this is not your report';
  end if;
  if v_sub.status not in ('approved', 'acknowledged') then
    raise exception 'a % report does not need an edit request', v_sub.status;
  end if;

  update reporting.submissions
  set status = 'edit_requested',
      request_reason = p_reason,
      requested_by = v_actor,
      requested_at = now()
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

-- The manager's answer to either request.
create or replace function reporting.review_request(
  p_submission_id uuid,
  p_grant boolean,
  p_reason text default null
)
returns reporting.submissions
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_sub reporting.submissions;
  v_actor text;
  v_dept public.department;
  v_was text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  select * into v_sub from reporting.submissions where id = p_submission_id for update;
  if not found then raise exception 'report not found'; end if;
  if v_sub.status not in ('cancel_requested', 'edit_requested') then
    raise exception 'there is no request on this report';
  end if;

  select department into v_dept from reporting.forms where id = v_sub.form_id;

  if not (
    public.can_approve_dept(v_dept::text, v_sub.store_id)
    or public.can_approve_for_email(v_sub.created_by)
  ) then
    raise exception 'you are not the approver for this report';
  end if;

  v_was := v_sub.status;

  update reporting.submissions
  set status = case
        when not p_grant then 'approved'          -- refused: leave it as it was
        when v_was = 'cancel_requested' then 'archived'
        else 'draft'                              -- edit granted: back to the author
      end,
      request_reason = case when p_grant then request_reason else p_reason end,
      -- An edit sends it round the approval loop again.
      approved_by = case when p_grant and v_was = 'edit_requested' then null else approved_by end,
      approved_at = case when p_grant and v_was = 'edit_requested' then null else approved_at end,
      acknowledged_by = case when p_grant and v_was = 'edit_requested' then null else acknowledged_by end,
      acknowledged_at = case when p_grant and v_was = 'edit_requested' then null else acknowledged_at end,
      submitted_at = case when p_grant and v_was = 'edit_requested' then null else submitted_at end
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. The owner's read
--
-- Per department, because the point is that the owner has read
-- warehouse's report - not that reports arrived. Several at once is fine;
-- the array is what a "select all" sends.
-- ---------------------------------------------------------------------

create or replace function reporting.acknowledge_reports(p_submission_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_actor text;
  v_count integer;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  if not public.is_director() then
    raise exception 'only the owner acknowledges reports';
  end if;

  update reporting.submissions
  set status = 'acknowledged',
      acknowledged_by = v_actor,
      acknowledged_at = now()
  where id = any(p_submission_ids)
    and status = 'approved';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Access
-- ---------------------------------------------------------------------

alter table reporting.incidents enable row level security;
alter table reporting.incident_routes enable row level security;

-- An incident is visible to whoever raised it, whoever it was sent to,
-- and the directors.
drop policy if exists "read incidents" on reporting.incidents;
create policy "read incidents" on reporting.incidents
  for select to authenticated using (
    public.is_director()
    or raised_by = (select email from public.profiles where id = auth.uid())
    or exists (
      select 1 from reporting.incident_routes r
      where r.incident_id = incidents.id
        and r.department::text = public.my_department()
    )
  );

drop policy if exists "read routes" on reporting.incident_routes;
create policy "read routes" on reporting.incident_routes
  for select to authenticated using (
    public.is_director()
    or department::text = public.my_department()
    or routed_by = (select email from public.profiles where id = auth.uid())
  );

grant select on reporting.incidents, reporting.incident_routes to authenticated;
grant select on reporting.incident_inbox to authenticated;

revoke all on function reporting.raise_incident(uuid, text, text, text, text[], text) from public, anon;
revoke all on function reporting.route_incident(uuid, text) from public, anon;
revoke all on function reporting.respond_incident(uuid, text) from public, anon;
revoke all on function reporting.request_cancel(uuid, text) from public, anon;
revoke all on function reporting.request_edit(uuid, text) from public, anon;
revoke all on function reporting.review_request(uuid, boolean, text) from public, anon;
revoke all on function reporting.acknowledge_reports(uuid[]) from public, anon;

grant execute on function reporting.raise_incident(uuid, text, text, text, text[], text) to authenticated;
grant execute on function reporting.route_incident(uuid, text) to authenticated;
grant execute on function reporting.respond_incident(uuid, text) to authenticated;
grant execute on function reporting.request_cancel(uuid, text) to authenticated;
grant execute on function reporting.request_edit(uuid, text) to authenticated;
grant execute on function reporting.review_request(uuid, boolean, text) to authenticated;
grant execute on function reporting.acknowledge_reports(uuid[]) to authenticated;
