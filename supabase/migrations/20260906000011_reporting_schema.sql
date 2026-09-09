-- =====================================================================
-- Daily reporting
-- Repo path: supabase/migrations/20260906000011_reporting_schema.sql
--
-- Nine departments file a daily report, each with its own fields. Writing
-- nine tables would mean nine migrations every time a field is added, and
-- an alter table every time a manager changes their mind - so the forms
-- are data, not schema. A form is a list of field definitions; a
-- submission is the answers as jsonb.
--
-- The trade is that the database cannot type-check an answer. That check
-- lives in the form definition instead: each field carries its type, and
-- the app validates against it. What the database does enforce is what
-- matters for an audit - one submission per form per day per store, who
-- filed it, who approved it, and every edit after the fact.
--
-- Fields are marked auto or manual. Everything is manual today; the flag
-- is there so the figures the POS already knows can be filled in from it
-- later without touching a form or a page.
--
-- Lives in its own schema. public.* is the POS and stays untouched.
-- =====================================================================

create schema if not exists reporting;
grant usage on schema reporting to authenticated;

-- ---------------------------------------------------------------------
-- 1. Form definitions
-- ---------------------------------------------------------------------

create table if not exists reporting.forms (
  id           text primary key,          -- 'hr_daily', 'warehouse_daily'
  name         text not null,
  name_mm      text,
  department   public.department not null,
  cadence      text not null default 'daily'
               check (cadence in ('daily', 'weekly', 'monthly')),
  -- Who fills it in and who checks it, as written on the form itself.
  filled_by    text,
  checked_by   text,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- A section groups fields on screen: "HR Data", "Recruitment Detail".
create table if not exists reporting.form_sections (
  id           uuid primary key default gen_random_uuid(),
  form_id      text not null references reporting.forms(id) on delete cascade,
  title        text not null,
  title_mm     text,
  -- A table section repeats its fields per row (suppliers, POs, errors);
  -- a plain section asks each field once.
  is_table     boolean not null default false,
  sort_order   integer not null default 0
);

create table if not exists reporting.form_fields (
  id           uuid primary key default gen_random_uuid(),
  section_id   uuid not null references reporting.form_sections(id) on delete cascade,
  key          text not null,             -- stable; answers are keyed by this
  label        text not null,
  label_mm     text,
  field_type   text not null default 'text'
               check (field_type in (
                 'text', 'textarea', 'number', 'money', 'percent',
                 'date', 'select', 'yesno', 'user', 'store', 'file'
               )),
  options      jsonb,                     -- for select: ["New","Pending",...]
  required     boolean not null default false,
  -- 'auto' fields are filled by hand today and will be sourced from the
  -- POS later; the source name says where from when that happens.
  source       text not null default 'manual'
               check (source in ('manual', 'auto')),
  source_key   text,
  help         text,
  sort_order   integer not null default 0,
  unique (section_id, key)
);

create index if not exists idx_form_sections_form on reporting.form_sections (form_id, sort_order);
create index if not exists idx_form_fields_section on reporting.form_fields (section_id, sort_order);

-- ---------------------------------------------------------------------
-- 2. Submissions
-- ---------------------------------------------------------------------

create table if not exists reporting.submissions (
  id            uuid primary key default gen_random_uuid(),
  form_id       text not null references reporting.forms(id),
  store_id      text references public.stores(id),
  report_date   date not null,
  status        text not null default 'draft'
                check (status in ('draft', 'submitted', 'approved', 'rejected')),

  -- Answers keyed by field key. Table sections hold an array of row
  -- objects under the section's key.
  answers       jsonb not null default '{}'::jsonb,

  -- The submitter's own read of the day, kept out of answers because
  -- every form asks for it and the dashboard sorts on it.
  overall_status text check (overall_status in ('normal', 'attention', 'critical')),

  submitted_by  text,
  submitted_at  timestamptz,
  approved_by   text,
  approved_at   timestamptz,
  rejected_by   text,
  rejected_at   timestamptz,
  reject_reason text,

  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One report per form per day per store. A branch that files twice has
  -- made a mistake, not a second report.
  unique (form_id, store_id, report_date)
);

create index if not exists idx_submissions_date on reporting.submissions (report_date desc);
create index if not exists idx_submissions_status on reporting.submissions (status);
create index if not exists idx_submissions_form on reporting.submissions (form_id, report_date desc);

-- ---------------------------------------------------------------------
-- 3. Open items
--
-- Every form carries pending actions with the same columns, and the value
-- of tracking them is seeing them across forms - so they get a table of
-- their own rather than living inside each submission's answers.
-- ---------------------------------------------------------------------

create table if not exists reporting.actions (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references reporting.submissions(id) on delete cascade,
  issue           text not null,
  responsible     text,
  start_date      date,
  deadline        date,
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'done', 'cancelled')),
  delay_reason    text,
  next_action     text,
  evidence        text,
  closed_at       timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_actions_submission on reporting.actions (submission_id);
create index if not exists idx_actions_open on reporting.actions (status, deadline)
  where status in ('open', 'in_progress');

-- Overdue is a question about today, so it is answered on read rather
-- than stored and left to go stale overnight.
create or replace view reporting.open_actions as
select
  a.*,
  s.form_id,
  s.store_id,
  s.report_date,
  case
    when a.status in ('done', 'cancelled') then 0
    when a.deadline is null then 0
    else greatest((current_date - a.deadline), 0)
  end as days_overdue
from reporting.actions a
join reporting.submissions s on s.id = a.submission_id;

-- ---------------------------------------------------------------------
-- 4. Edit history
--
-- A submitted report can still be corrected, and the correction is the
-- thing an auditor asks about: who changed what, when, and from what.
-- ---------------------------------------------------------------------

create table if not exists reporting.submission_edits (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references reporting.submissions(id) on delete cascade,
  edited_by     text not null,
  edited_at     timestamptz not null default now(),
  field_key     text,
  old_value     jsonb,
  new_value     jsonb,
  note          text
);

create index if not exists idx_edits_submission on reporting.submission_edits (submission_id, edited_at desc);

create or replace function reporting.record_edit()
returns trigger
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_actor text;
  v_key text;
begin
  select email into v_actor from public.profiles where id = auth.uid();

  -- A draft is still being written; history starts once it is filed.
  if old.status = 'draft' then
    new.updated_at := now();
    return new;
  end if;

  if new.answers is distinct from old.answers then
    -- One row per changed field, so the history reads as a list of
    -- corrections rather than two blobs to diff by eye.
    for v_key in
      select key from jsonb_each(new.answers)
      where new.answers -> key is distinct from old.answers -> key
      union
      select key from jsonb_each(old.answers)
      where new.answers -> key is distinct from old.answers -> key
    loop
      insert into reporting.submission_edits
        (submission_id, edited_by, field_key, old_value, new_value)
      values (old.id, coalesce(v_actor, 'unknown'), v_key,
              old.answers -> v_key, new.answers -> v_key);
    end loop;
  end if;

  if new.status is distinct from old.status then
    insert into reporting.submission_edits
      (submission_id, edited_by, field_key, old_value, new_value)
    values (old.id, coalesce(v_actor, 'unknown'), '_status',
            to_jsonb(old.status), to_jsonb(new.status));
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists record_submission_edit on reporting.submissions;
create trigger record_submission_edit
  before update on reporting.submissions
  for each row execute function reporting.record_edit();

-- ---------------------------------------------------------------------
-- 5. Who sees what
--
-- The org structure already answers this: department, reporting line and
-- store scope live in public.profiles. Reports reuse them rather than
-- inventing a second set of roles.
-- ---------------------------------------------------------------------

alter table reporting.forms enable row level security;
alter table reporting.form_sections enable row level security;
alter table reporting.form_fields enable row level security;
alter table reporting.submissions enable row level security;
alter table reporting.actions enable row level security;
alter table reporting.submission_edits enable row level security;

-- Form definitions are readable by everyone signed in: a form nobody can
-- read is a form nobody can fill.
drop policy if exists "read forms" on reporting.forms;
create policy "read forms" on reporting.forms
  for select to authenticated using (true);

drop policy if exists "read sections" on reporting.form_sections;
create policy "read sections" on reporting.form_sections
  for select to authenticated using (true);

drop policy if exists "read fields" on reporting.form_fields;
create policy "read fields" on reporting.form_fields
  for select to authenticated using (true);

drop policy if exists "admin edits forms" on reporting.forms;
create policy "admin edits forms" on reporting.forms
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin edits sections" on reporting.form_sections;
create policy "admin edits sections" on reporting.form_sections
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin edits fields" on reporting.form_fields;
create policy "admin edits fields" on reporting.form_fields
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- You see your own reports, your department's, and any store you cover.
-- Directors see all of them.
drop policy if exists "read submissions" on reporting.submissions;
create policy "read submissions" on reporting.submissions
  for select to authenticated using (
    public.is_director()
    or created_by = (select email from public.profiles where id = auth.uid())
    or exists (
      select 1
      from reporting.forms f, public.profiles me
      where f.id = submissions.form_id
        and me.id = auth.uid()
        and me.department = f.department
    )
    or (store_id is not null and public.covers_store(store_id))
  );

drop policy if exists "write own submissions" on reporting.submissions;
create policy "write own submissions" on reporting.submissions
  for insert to authenticated with check (
    created_by = (select email from public.profiles where id = auth.uid())
  );

-- A draft belongs to whoever is writing it. Once filed, only the
-- approval RPCs move it - the app never updates status directly.
drop policy if exists "edit own drafts" on reporting.submissions;
create policy "edit own drafts" on reporting.submissions
  for update to authenticated using (
    created_by = (select email from public.profiles where id = auth.uid())
    or public.is_director()
  );

drop policy if exists "read actions" on reporting.actions;
create policy "read actions" on reporting.actions
  for select to authenticated using (
    exists (select 1 from reporting.submissions s where s.id = actions.submission_id)
  );

drop policy if exists "write actions" on reporting.actions;
create policy "write actions" on reporting.actions
  for all to authenticated using (
    exists (
      select 1 from reporting.submissions s
      where s.id = actions.submission_id
        and (s.created_by = (select email from public.profiles where id = auth.uid())
             or public.is_director())
    )
  ) with check (
    exists (select 1 from reporting.submissions s where s.id = actions.submission_id)
  );

-- History is read-only to everyone; only the trigger writes it.
drop policy if exists "read edits" on reporting.submission_edits;
create policy "read edits" on reporting.submission_edits
  for select to authenticated using (
    exists (select 1 from reporting.submissions s where s.id = submission_edits.submission_id)
  );

grant select on all tables in schema reporting to authenticated;
grant insert, update, delete on reporting.submissions, reporting.actions to authenticated;
grant insert, update, delete on reporting.forms, reporting.form_sections, reporting.form_fields to authenticated;

-- ---------------------------------------------------------------------
-- 6. Filing and signing off
-- ---------------------------------------------------------------------

create or replace function reporting.submit_report(p_submission_id uuid)
returns reporting.submissions
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_sub reporting.submissions;
  v_actor text;
  v_missing text;
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  select * into v_sub from reporting.submissions where id = p_submission_id for update;
  if not found then raise exception 'report not found'; end if;
  if v_sub.created_by <> v_actor and not public.is_director() then
    raise exception 'this is not your report';
  end if;
  if v_sub.status <> 'draft' then
    raise exception 'this report is already %', v_sub.status;
  end if;

  -- Required fields are checked here rather than in the page, so a report
  -- cannot be filed complete by anything that skips the form.
  select string_agg(ff.label, ', ') into v_missing
  from reporting.form_fields ff
  join reporting.form_sections fs on fs.id = ff.section_id
  where fs.form_id = v_sub.form_id
    and ff.required
    and not fs.is_table
    and coalesce(v_sub.answers ->> ff.key, '') = '';

  if v_missing is not null then
    raise exception 'still to fill in: %', v_missing;
  end if;

  update reporting.submissions
  set status = 'submitted', submitted_by = v_actor, submitted_at = now()
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

create or replace function reporting.review_report(
  p_submission_id uuid,
  p_reject boolean default false,
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
begin
  select email into v_actor from public.profiles where id = auth.uid();
  if v_actor is null then raise exception 'not signed in'; end if;

  select * into v_sub from reporting.submissions where id = p_submission_id for update;
  if not found then raise exception 'report not found'; end if;
  if v_sub.status <> 'submitted' then
    raise exception 'this report is % and is not waiting on you', v_sub.status;
  end if;

  select department into v_dept from reporting.forms where id = v_sub.form_id;

  -- The head of the department the form belongs to, or the submitter's own
  -- line manager. Nobody signs off their own report.
  if v_sub.created_by = v_actor and not public.is_director() then
    raise exception 'you cannot approve your own report';
  end if;

  if not (
    public.can_approve_dept(v_dept::text, v_sub.store_id)
    or public.can_approve_for_email(v_sub.created_by)
  ) then
    raise exception 'you are not the approver for this report';
  end if;

  if p_reject and coalesce(p_reason, '') = '' then
    raise exception 'a rejection needs a reason';
  end if;

  update reporting.submissions
  set status = case when p_reject then 'rejected' else 'approved' end,
      approved_by = case when p_reject then approved_by else v_actor end,
      approved_at = case when p_reject then approved_at else now() end,
      rejected_by = case when p_reject then v_actor else rejected_by end,
      rejected_at = case when p_reject then now() else rejected_at end,
      reject_reason = case when p_reject then p_reason else reject_reason end
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

-- A rejected report goes back to its author to fix and file again.
create or replace function reporting.reopen_report(p_submission_id uuid)
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

  select * into v_sub from reporting.submissions where id = p_submission_id for update;
  if not found then raise exception 'report not found'; end if;
  if v_sub.status <> 'rejected' then
    raise exception 'only a rejected report can be reopened';
  end if;
  if v_sub.created_by <> v_actor and not public.is_director() then
    raise exception 'this is not your report';
  end if;

  update reporting.submissions
  set status = 'draft', submitted_at = null, submitted_by = null
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

revoke all on function reporting.submit_report(uuid) from public, anon;
revoke all on function reporting.review_report(uuid, boolean, text) from public, anon;
revoke all on function reporting.reopen_report(uuid) from public, anon;
grant execute on function reporting.submit_report(uuid) to authenticated;
grant execute on function reporting.review_report(uuid, boolean, text) to authenticated;
grant execute on function reporting.reopen_report(uuid) to authenticated;
