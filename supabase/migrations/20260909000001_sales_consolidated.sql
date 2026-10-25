-- =====================================================================
-- The consolidated sales report
-- Repo path: supabase/migrations/20260909000001_sales_consolidated.sql
--
-- Six places sell: four shops, online and wholesale. Each files its own
-- numbers. Asking the sales manager to retype them into a seventh form
-- would put the same figure in two places, and the day they disagree
-- nobody knows which is the sale.
--
-- So the consolidated report reads the submissions rather than asking
-- for them. The manager writes the part only they can: what the numbers
-- mean and what happens next.
--
-- A shop that has not filed shows as not filed. That absence is the most
-- useful thing on the page at nine in the morning, and averaging it away
-- would hide it.
--
-- Idempotent - safe to re-run.
-- =====================================================================

insert into public.report_forms
  (id, name, name_mm, department, cadence, filled_by, checked_by, sort_order, allowed_roles)
values (
  'sales_consolidated',
  'Sales Consolidated Daily Report',
  'အရောင်း စုစည်း နေ့စဉ်အစီရင်ခံစာ',
  'sale', 'daily',
  'Sales Manager', 'Operation Director / Owner', 9,
  array['sale_manager', 'operation_director', 'owner', 'admin']
)
on conflict (id) do update set
  name = excluded.name,
  name_mm = excluded.name_mm,
  allowed_roles = excluded.allowed_roles,
  sort_order = excluded.sort_order;

-- The manager's own section. The figures are not here because they are
-- not the manager's to enter.
create or replace function public.reporting_seed_consolidated()
returns void
language plpgsql
as $$
declare
  v_section uuid;
begin
  select id into v_section from public.report_sections
  where form_id = 'sales_consolidated' and title = 'Manager Review';

  if v_section is null then
    insert into public.report_sections (form_id, title, title_mm, is_table, sort_order)
    values ('sales_consolidated', 'Manager Review', 'မန်နေဂျာ သုံးသပ်ချက်', false, 1)
    returning id into v_section;
  end if;

  insert into public.report_fields
    (section_id, key, label, label_mm, field_type, required, sort_order)
  values
    (v_section, 'day_summary',      'How the day went',        'ယနေ့ အခြေအနေ',        'textarea', true,  1),
    (v_section, 'underperformers',  'Behind target — why',     'ပန်းတိုင် မမီရသည့် အကြောင်း', 'textarea', false, 2),
    (v_section, 'stockout_impact',  'Stock-outs and lost sale','ကုန်သွား၍ ဆုံးရှုံးမှု',    'textarea', false, 3),
    (v_section, 'staff_notes',      'Staff',                   'ဝန်ထမ်း ကိစ္စ',          'textarea', false, 4),
    (v_section, 'action_plan',      'What happens tomorrow',   'မနက်ဖြန် လုပ်ဆောင်ရန်',   'textarea', true,  5)
  on conflict (section_id, key) do update set
    label = excluded.label,
    label_mm = excluded.label_mm,
    field_type = excluded.field_type,
    required = excluded.required,
    sort_order = excluded.sort_order;
end;
$$;

select public.reporting_seed_consolidated();
drop function public.reporting_seed_consolidated();

-- ---------------------------------------------------------------------
-- What the consolidated view reads
--
-- One row per selling place for the day, whether or not it reported.
-- The channel rows live inside each submission's table section, so the
-- figures are pulled out of the jsonb rather than joined from columns.
-- ---------------------------------------------------------------------

create or replace function public.sales_consolidated(p_date date)
returns table (
  store_id      text,
  store_name    text,
  filed         boolean,
  status        text,
  filed_by      text,
  daily_target  numeric,
  actual_sale   numeric,
  invoice_count numeric,
  customers_in  numeric,
  credit_sale   numeric,
  return_count  numeric,
  lost_sale     numeric,
  stockout      text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  -- Whoever can sign off the sale department can read across it; RLS on
  -- the submissions themselves is what stops anyone else.
  if not (public.can_approve_dept('sale') or public.is_director()
          or public.my_department() = 'sale') then
    raise exception 'this is the sale department''s report';
  end if;

  return query
  with filed_rows as (
    select
      s.store_id,
      s.status,
      s.created_by,
      -- Each shop files one channel row; sum in case a store reports
      -- several (online and counter from the same account, say).
      sum((line->>'daily_target')::numeric)      as daily_target,
      sum((line->>'actual_sale')::numeric)       as actual_sale,
      sum((line->>'invoice_count')::numeric)     as invoice_count,
      sum((line->>'customer_entrance')::numeric) as customers_in,
      sum((line->>'credit_sale')::numeric)       as credit_sale,
      sum((line->>'return_count')::numeric)      as return_count,
      sum((line->>'lost_sale')::numeric)         as lost_sale,
      string_agg(nullif(line->>'stockout_product', ''), ' · ') as stockout
    from public.report_submissions s
    join public.report_sections fs
      on fs.form_id = s.form_id and fs.is_table
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(s.answers -> fs.id::text) = 'array'
        then s.answers -> fs.id::text
        else '[]'::jsonb
      end
    ) as line
    where s.form_id = 'sales_daily'
      and s.report_date = p_date
      and s.status not in ('draft', 'archived', 'rejected')
    group by s.store_id, s.status, s.created_by
  )
  select
    st.id,
    st.name,
    f.store_id is not null,
    coalesce(f.status, 'not filed'),
    f.created_by,
    coalesce(f.daily_target, 0),
    coalesce(f.actual_sale, 0),
    coalesce(f.invoice_count, 0),
    coalesce(f.customers_in, 0),
    coalesce(f.credit_sale, 0),
    coalesce(f.return_count, 0),
    coalesce(f.lost_sale, 0),
    f.stockout
  from public.stores st
  left join filed_rows f on f.store_id = st.id
  where not st.is_warehouse
  order by st.name;
end;
$$;

revoke all on function public.sales_consolidated(date) from public, anon;
grant execute on function public.sales_consolidated(date) to authenticated;
