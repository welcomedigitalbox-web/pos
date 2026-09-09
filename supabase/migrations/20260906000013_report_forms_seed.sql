-- =====================================================================
-- The forms themselves
-- Repo path: supabase/migrations/20260906000013_report_forms_seed.sql
--
-- Eight departmental forms, transcribed from the template. They go in as
-- data because that is what the schema treats them as: adding a field
-- tomorrow is an insert, not a migration.
--
-- Fields the POS already knows - takings, stock counts, PO status - are
-- marked source='auto' with the query that will fill them. Today they are
-- typed in like everything else; the flag is what lets that change later
-- without touching a form or a page.
--
-- Re-runnable: every insert is keyed and upserts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Forms
-- ---------------------------------------------------------------------

insert into reporting.forms (id, name, name_mm, department, filled_by, checked_by, sort_order) values
  ('hr_daily',            'HR & Admin Daily Report',      'HR & Admin နေ့စဉ်အစီရင်ခံစာ',        'sale',          'HR & Admin Executive/Assistant Manager', 'Operation Manager/MD', 1),
  ('warehouse_daily',     'Warehouse Daily Report',       'ဂိုဒေါင် နေ့စဉ်အစီရင်ခံစာ',           'warehouse',     'Warehouse Supervisor',                  'Inventory Accountant/Operation Manager', 2),
  ('merchandising_daily', 'Merchandising Daily Report',   'ကုန်ပစ္စည်း နေ့စဉ်အစီရင်ခံစာ',        'merchandising', 'Merchandising Assistant',               'Merchandising Manager', 3),
  ('cash_daily',          'Cash Account Daily Report',    'ငွေစာရင်း နေ့စဉ်အစီရင်ခံစာ',          'finance',       'Cash Accountant/Cashier',               'Senior Accountant/Audit', 4),
  ('inventory_daily',     'Inventory Account Daily Report','စာရင်းကိုင် နေ့စဉ်အစီရင်ခံစာ',       'finance',       'Inventory Accountant',                  'Senior Accountant/Audit', 5),
  ('sales_daily',         'Sales Manager Daily Report',   'အရောင်း နေ့စဉ်အစီရင်ခံစာ',            'sale',          'Sales Manager',                         'Operation Director', 6),
  ('wholesale_daily',     'Wholesale Daily Report',       'လက်ကား နေ့စဉ်အစီရင်ခံစာ',            'sale',          'Wholesale Team Leader',                 'Sales Manager', 7),
  ('marketing_daily',     'Digital Marketing Daily Report','စျေးကွက် နေ့စဉ်အစီရင်ခံစာ',          'marketing',     'Digital Marketing Executive',           'Marketing AM', 8)
on conflict (id) do update set
  name = excluded.name,
  name_mm = excluded.name_mm,
  department = excluded.department,
  filled_by = excluded.filled_by,
  checked_by = excluded.checked_by,
  sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- A helper so the field lists below read as lists rather than SQL
-- ---------------------------------------------------------------------

create or replace function reporting.seed_section(
  p_form text,
  p_key text,
  p_title text,
  p_title_mm text,
  p_is_table boolean,
  p_order integer,
  p_fields jsonb          -- [{key,label,type,required,source,options}]
)
returns void
language plpgsql
as $$
declare
  v_section uuid;
  v_field jsonb;
  v_i integer := 0;
begin
  -- Sections have no natural key, so the title within a form is it.
  select id into v_section
  from reporting.form_sections
  where form_id = p_form and title = p_title;

  if v_section is null then
    insert into reporting.form_sections (form_id, title, title_mm, is_table, sort_order)
    values (p_form, p_title, p_title_mm, p_is_table, p_order)
    returning id into v_section;
  else
    update reporting.form_sections
    set title_mm = p_title_mm, is_table = p_is_table, sort_order = p_order
    where id = v_section;
  end if;

  for v_field in select * from jsonb_array_elements(p_fields) loop
    v_i := v_i + 1;
    insert into reporting.form_fields
      (section_id, key, label, label_mm, field_type, options, required, source, source_key, sort_order)
    values (
      v_section,
      v_field->>'key',
      v_field->>'label',
      v_field->>'label_mm',
      coalesce(v_field->>'type', 'text'),
      v_field->'options',
      coalesce((v_field->>'required')::boolean, false),
      coalesce(v_field->>'source', 'manual'),
      v_field->>'source_key',
      v_i
    )
    on conflict (section_id, key) do update set
      label = excluded.label,
      label_mm = excluded.label_mm,
      field_type = excluded.field_type,
      options = excluded.options,
      required = excluded.required,
      source = excluded.source,
      source_key = excluded.source_key,
      sort_order = excluded.sort_order;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. HR & Admin
-- ---------------------------------------------------------------------

select reporting.seed_section('hr_daily', 'hr_data', 'HR Data', 'ဝန်ထမ်း အချက်အလက်', false, 1, '[
  {"key":"total_employees","label":"Total Employees","label_mm":"ဝန်ထမ်း စုစုပေါင်း","type":"number","required":true},
  {"key":"present","label":"Present","label_mm":"တက်","type":"number","required":true},
  {"key":"leave","label":"Leave","label_mm":"ခွင့်","type":"number"},
  {"key":"off","label":"Off","label_mm":"နားရက်","type":"number"},
  {"key":"absent","label":"Absent","label_mm":"ပျက်ကွက်","type":"number"},
  {"key":"late","label":"Late","label_mm":"နောက်ကျ","type":"number"},
  {"key":"attendance_pct","label":"Attendance %","label_mm":"တက်ရောက်မှု %","type":"percent"},
  {"key":"new_joiner","label":"New Joiner","label_mm":"ဝန်ထမ်းသစ်","type":"number"},
  {"key":"resignation","label":"Resignation","label_mm":"နုတ်ထွက်","type":"number"},
  {"key":"interview_count","label":"Interview Count","label_mm":"အင်တာဗျူး","type":"number"},
  {"key":"open_vacancies","label":"Open Vacancies","label_mm":"လစ်လပ်နေရာ","type":"number"},
  {"key":"staff_complaint_count","label":"Staff Complaint Count","label_mm":"ဝန်ထမ်း တိုင်ကြားမှု","type":"number"},
  {"key":"staff_request_count","label":"Staff Request Count","label_mm":"ဝန်ထမ်း တောင်းဆိုမှု","type":"number"}
]'::jsonb);

select reporting.seed_section('hr_daily', 'recruitment', 'Recruitment Detail', 'ခေါ်ယူမှု အသေးစိတ်', true, 2, '[
  {"key":"position","label":"Position","label_mm":"ရာထူး"},
  {"key":"required_headcount","label":"Required Headcount","label_mm":"လိုအပ်ချက်","type":"number"},
  {"key":"candidate_count","label":"Candidate Count","label_mm":"လျှောက်ထားသူ","type":"number"},
  {"key":"interview_date","label":"Interview Date","label_mm":"အင်တာဗျူးရက်","type":"date"},
  {"key":"selected_count","label":"Selected Count","label_mm":"ရွေးချယ်ပြီး","type":"number"},
  {"key":"expected_joining","label":"Expected Joining Date","label_mm":"ဝင်မည့်ရက်","type":"date"},
  {"key":"priority","label":"Priority","label_mm":"ဦးစားပေး","type":"select","options":["High","Medium","Low"]},
  {"key":"responsible","label":"Responsible Person","label_mm":"တာဝန်ရှိသူ","type":"user"}
]'::jsonb);

select reporting.seed_section('hr_daily', 'admin_support', 'Admin / Branch Support', 'ဌာနခွဲ ပံ့ပိုးမှု', true, 3, '[
  {"key":"branch","label":"Requesting Branch","label_mm":"တောင်းဆိုသည့် ဆိုင်","type":"store"},
  {"key":"issue","label":"Issue / Request","label_mm":"ကိစ္စ"},
  {"key":"action_taken","label":"Action Taken","label_mm":"ဆောင်ရွက်ချက်"},
  {"key":"responsible","label":"Responsible Person","label_mm":"တာဝန်ရှိသူ","type":"user"},
  {"key":"deadline","label":"Deadline","label_mm":"နောက်ဆုံးရက်","type":"date"},
  {"key":"status","label":"Status","label_mm":"အခြေအနေ","type":"select","options":["Open","In Progress","Done"]},
  {"key":"cost","label":"Cost","label_mm":"ကုန်ကျစရိတ်","type":"money"},
  {"key":"evidence","label":"Evidence","label_mm":"အထောက်အထား","type":"file"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 3. Warehouse
-- ---------------------------------------------------------------------

select reporting.seed_section('warehouse_daily', 'incoming', 'Incoming Stock', 'ဝင်လာသော ကုန်ပစ္စည်း', true, 1, '[
  {"key":"supplier","label":"Supplier","label_mm":"ပေးသွင်းသူ"},
  {"key":"po_no","label":"PO / Invoice No.","label_mm":"PO နံပါတ်"},
  {"key":"product_code","label":"Product Code","label_mm":"ကုန်ပစ္စည်းကုဒ်"},
  {"key":"product_name","label":"Product Name","label_mm":"ကုန်ပစ္စည်းအမည်"},
  {"key":"quantity","label":"Quantity","label_mm":"အရေအတွက်","type":"number"},
  {"key":"received_qty","label":"Received Quantity","label_mm":"လက်ခံရရှိ","type":"number"},
  {"key":"difference","label":"Difference","label_mm":"ကွာခြား","type":"number"},
  {"key":"qc_status","label":"QC Status","label_mm":"QC","type":"select","options":["Pass","Fail","Partial"]},
  {"key":"barcode_status","label":"Barcode Status","label_mm":"ဘားကုဒ်","type":"select","options":["Done","Pending"]},
  {"key":"system_updated","label":"System Updated","label_mm":"စနစ်ထဲ ထည့်ပြီး","type":"yesno"},
  {"key":"ready_for_sale","label":"Ready for Sale","label_mm":"ရောင်းရန် အဆင်သင့်","type":"yesno"}
]'::jsonb);

select reporting.seed_section('warehouse_daily', 'fulfilment', 'Order Fulfilment', 'အော်ဒါ ဖြည့်ဆည်းမှု', true, 2, '[
  {"key":"channel","label":"Channel","label_mm":"ချန်နယ်","type":"select","options":["Retail","Online","Wholesale"]},
  {"key":"prepared","label":"Prepared Voucher / Qty","label_mm":"ပြင်ဆင်ပြီး"},
  {"key":"dispatched","label":"Dispatched Voucher / Qty","label_mm":"ပို့ပြီး"},
  {"key":"pending","label":"Pending Voucher / Qty","label_mm":"ကျန်ရှိ"},
  {"key":"pending_reason","label":"Pending Reason","label_mm":"ကျန်ရှိရသည့် အကြောင်း"},
  {"key":"courier","label":"Courier / Delivery Method","label_mm":"ပို့ဆောင်ရေး"},
  {"key":"expected_dispatch","label":"Expected Dispatch Date","label_mm":"ပို့မည့်ရက်","type":"date"}
]'::jsonb);

select reporting.seed_section('warehouse_daily', 'errors', 'Error / Return', 'အမှား / ပြန်အမ်း', true, 3, '[
  {"key":"date","label":"Date","label_mm":"ရက်စွဲ","type":"date"},
  {"key":"channel","label":"Channel","label_mm":"ချန်နယ်","type":"select","options":["Retail","Online","Wholesale"]},
  {"key":"invoice_no","label":"Invoice No.","label_mm":"ငွေတောင်းခံလွှာ"},
  {"key":"customer","label":"Customer / Dealer","label_mm":"ဖောက်သည်"},
  {"key":"product_code","label":"Product Code","label_mm":"ကုန်ပစ္စည်းကုဒ်"},
  {"key":"product_name","label":"Product Name","label_mm":"ကုန်ပစ္စည်းအမည်"},
  {"key":"error_cases","label":"Error Cases","label_mm":"အမှား အရေအတွက်","type":"number"},
  {"key":"error_qty","label":"Error Quantity","label_mm":"အမှား ပမာဏ","type":"number"},
  {"key":"error_type","label":"Error Type","label_mm":"အမှားအမျိုးအစား"},
  {"key":"warranty","label":"Warranty Status","label_mm":"အာမခံ","type":"select","options":["In Warranty","Out of Warranty","N/A"]},
  {"key":"accountant_notified","label":"Inventory Accountant Notified","label_mm":"စာရင်းကိုင် အသိပေးပြီး","type":"yesno"},
  {"key":"return_in_no","label":"Return-In No.","label_mm":"Return-In နံပါတ်"},
  {"key":"action_taken","label":"Action Taken","label_mm":"ဆောင်ရွက်ချက်"},
  {"key":"responsible","label":"Responsible Person","label_mm":"တာဝန်ရှိသူ","type":"user"},
  {"key":"deadline","label":"Deadline","label_mm":"နောက်ဆုံးရက်","type":"date"},
  {"key":"status","label":"Current Status","label_mm":"အခြေအနေ","type":"select","options":["Open","In Progress","Done"]},
  {"key":"evidence","label":"Photo / Video Evidence","label_mm":"အထောက်အထား","type":"file"}
]'::jsonb);

select reporting.seed_section('warehouse_daily', 'control', 'Warehouse Control', 'ဂိုဒေါင် ထိန်းချုပ်မှု', false, 4, '[
  {"key":"damaged_count","label":"Damaged Product Count","label_mm":"ပျက်စီး","type":"number","source":"auto","source_key":"damage_count"},
  {"key":"picking_error","label":"Picking Error Count","label_mm":"ထုတ်ယူ အမှား","type":"number"},
  {"key":"packing_error","label":"Packing Error Count","label_mm":"ထုပ်ပိုး အမှား","type":"number"},
  {"key":"stock_difference","label":"Stock Difference Count","label_mm":"လက်ကျန် ကွာခြား","type":"number","source":"auto","source_key":"stock_variance"},
  {"key":"negative_stock","label":"Negative Stock Count","label_mm":"အနုတ် လက်ကျန်","type":"number","source":"auto","source_key":"negative_stock"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 4. Merchandising
-- ---------------------------------------------------------------------

select reporting.seed_section('merchandising_daily', 'po', 'Purchase Orders', 'ဝယ်ယူမှု အော်ဒါ', true, 1, '[
  {"key":"supplier","label":"Supplier","label_mm":"ပေးသွင်းသူ"},
  {"key":"category","label":"Category","label_mm":"အမျိုးအစား"},
  {"key":"po_no","label":"PO No.","label_mm":"PO နံပါတ်"},
  {"key":"po_date","label":"PO Date","label_mm":"PO ရက်စွဲ","type":"date"},
  {"key":"po_status","label":"PO Status","label_mm":"အခြေအနေ","type":"select","options":["New","Pending","Confirmed","Cancelled"]},
  {"key":"payment_term","label":"Payment Term","label_mm":"ငွေပေးချေမှု"},
  {"key":"confirmed_amount","label":"Confirmed Amount","label_mm":"အတည်ပြု ပမာဏ","type":"money"},
  {"key":"budget_amount","label":"Budget Amount","label_mm":"ခန့်မှန်း ပမာဏ","type":"money"},
  {"key":"expected_arrival","label":"Expected Arrival Date","label_mm":"ရောက်မည့်ရက်","type":"date"},
  {"key":"responsible","label":"Responsible Person","label_mm":"တာဝန်ရှိသူ","type":"user"}
]'::jsonb);

select reporting.seed_section('merchandising_daily', 'product_mgmt', 'Product Management', 'ကုန်ပစ္စည်း စီမံခန့်ခွဲမှု', true, 2, '[
  {"key":"product_code","label":"Product Code","label_mm":"ကုန်ပစ္စည်းကုဒ်"},
  {"key":"product_name","label":"Product Name","label_mm":"ကုန်ပစ္စည်းအမည်"},
  {"key":"current_stock","label":"Current Stock","label_mm":"လက်ကျန်","type":"number","source":"auto","source_key":"stock_on_hand"},
  {"key":"average_sale","label":"Average Sale","label_mm":"ပျမ်းမျှ ရောင်းအား","type":"number","source":"auto","source_key":"avg_daily_sale"},
  {"key":"stock_out","label":"Stock-out","label_mm":"ကုန်သွား","type":"yesno"},
  {"key":"reorder_needed","label":"Reorder Needed","label_mm":"ပြန်မှာရန်","type":"yesno"},
  {"key":"reorder_qty","label":"Reorder Quantity","label_mm":"မှာမည့် ပမာဏ","type":"number"},
  {"key":"overstock_risk","label":"Overstock Risk","label_mm":"ပိုလျှံ အန္တရာယ်","type":"yesno"},
  {"key":"action_taken","label":"Action Taken","label_mm":"ဆောင်ရွက်ချက်"},
  {"key":"deadline","label":"Deadline","label_mm":"နောက်ဆုံးရက်","type":"date"}
]'::jsonb);

select reporting.seed_section('merchandising_daily', 'supplier', 'Supplier & Pricing', 'ပေးသွင်းသူနှင့် ဈေးနှုန်း', false, 3, '[
  {"key":"supplier_followup","label":"Supplier Follow-up","label_mm":"ပေးသွင်းသူ ဆက်သွယ်မှု","type":"textarea"},
  {"key":"shipment_status","label":"Shipment Status","label_mm":"တင်ပို့မှု","type":"select","options":["Production","Ready","In Transit","Arrived","Delayed"]},
  {"key":"price_change","label":"Price Change","label_mm":"ဈေးပြောင်းလဲမှု","type":"textarea"},
  {"key":"retail_price_update","label":"Retail Price Update","label_mm":"လက်လီဈေး","type":"textarea"},
  {"key":"wholesale_price_update","label":"Wholesale Price Update","label_mm":"လက်ကားဈေး","type":"textarea"},
  {"key":"new_product_review","label":"New Product Review","label_mm":"ပစ္စည်းသစ်","type":"textarea"},
  {"key":"quality_issue","label":"Product Quality Issue","label_mm":"အရည်အသွေး ပြဿနာ","type":"textarea"},
  {"key":"supplier_risk","label":"Supplier Risk","label_mm":"ပေးသွင်းသူ အန္တရာယ်","type":"textarea"},
  {"key":"negotiation","label":"Negotiation Update","label_mm":"ညှိနှိုင်းမှု","type":"textarea"},
  {"key":"approval_needed","label":"Approval Needed","label_mm":"အတည်ပြုချက် လိုအပ်","type":"textarea"},
  {"key":"documents","label":"Required Documents","label_mm":"လိုအပ်သော စာရွက်စာတမ်း","type":"textarea"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 5. Cash Account
-- ---------------------------------------------------------------------

select reporting.seed_section('cash_daily', 'sales_collection', 'Daily Sales & Collection', 'နေ့စဉ် ရောင်းရငွေ', true, 1, '[
  {"key":"branch","label":"Branch / Channel","label_mm":"ဆိုင် / ချန်နယ်","type":"store"},
  {"key":"total_sale","label":"Total Sale","label_mm":"စုစုပေါင်း","type":"money","source":"auto","source_key":"total_sale"},
  {"key":"cash_sale","label":"Cash Sale","label_mm":"ငွေသား","type":"money","source":"auto","source_key":"cash_sale"},
  {"key":"bank_sale","label":"Bank / Pay Sale","label_mm":"ဘဏ်","type":"money","source":"auto","source_key":"bank_sale"},
  {"key":"credit_sale","label":"Credit Sale","label_mm":"အကြွေး","type":"money","source":"auto","source_key":"credit_sale"},
  {"key":"collected","label":"Collected Amount","label_mm":"ကောက်ခံရရှိ","type":"money"},
  {"key":"outstanding","label":"Outstanding Amount","label_mm":"ကျန်ရှိ","type":"money"}
]'::jsonb);

select reporting.seed_section('cash_daily', 'payment_methods', 'Payment Methods', 'ငွေပေးချေမှု နည်းလမ်း', false, 2, '[
  {"key":"cash","label":"Cash","label_mm":"ငွေသား","type":"money"},
  {"key":"kbz","label":"KBZ","type":"money"},
  {"key":"aya","label":"AYA","type":"money"},
  {"key":"kpay","label":"KPay","type":"money"},
  {"key":"wave","label":"Wave","type":"money"},
  {"key":"other_bank","label":"Other Bank","label_mm":"အခြားဘဏ်","type":"money"},
  {"key":"total_received","label":"Total Received","label_mm":"စုစုပေါင်း ရရှိ","type":"money"}
]'::jsonb);

select reporting.seed_section('cash_daily', 'cashbook', 'Cashbook', 'ငွေစာရင်း', false, 3, '[
  {"key":"opening_balance","label":"Opening Balance","label_mm":"အဖွင့် လက်ကျန်","type":"money","required":true},
  {"key":"cash_in","label":"Cash In","label_mm":"ငွေဝင်","type":"money"},
  {"key":"cash_out","label":"Cash Out","label_mm":"ငွေထွက်","type":"money"},
  {"key":"total_expense","label":"Total Expense","label_mm":"စုစုပေါင်း အသုံးစရိတ်","type":"money"},
  {"key":"expected_closing","label":"Expected Closing Balance","label_mm":"ခန့်မှန်း အပိတ်","type":"money"},
  {"key":"physical_closing","label":"Physical Closing Balance","label_mm":"အမှန်တကယ် အပိတ်","type":"money","required":true},
  {"key":"cash_difference","label":"Cash Difference","label_mm":"ကွာခြားချက်","type":"money"},
  {"key":"difference_reason","label":"Difference Reason","label_mm":"ကွာခြားရသည့် အကြောင်း","type":"textarea"}
]'::jsonb);

select reporting.seed_section('cash_daily', 'cash_out', 'Cash / Bank Out', 'ငွေထုတ်', true, 4, '[
  {"key":"date","label":"Date","label_mm":"ရက်စွဲ","type":"date"},
  {"key":"payment_type","label":"Payment Type","label_mm":"အမျိုးအစား","type":"select","options":["Cash","Bank Transfer","Mobile"]},
  {"key":"payee","label":"Payee","label_mm":"လက်ခံသူ"},
  {"key":"purpose","label":"Purpose","label_mm":"ရည်ရွယ်ချက်"},
  {"key":"voucher_no","label":"Voucher No.","label_mm":"ဘောက်ချာနံပါတ်"},
  {"key":"account","label":"Cash / Bank Account","label_mm":"အကောင့်"},
  {"key":"amount","label":"Amount","label_mm":"ပမာဏ","type":"money"},
  {"key":"approved_by","label":"Approved By","label_mm":"အတည်ပြုသူ","type":"user"},
  {"key":"evidence","label":"Evidence","label_mm":"အထောက်အထား","type":"file"}
]'::jsonb);

select reporting.seed_section('cash_daily', 'reconciliation', 'Reconciliation', 'ညှိနှိုင်းစစ်ဆေးမှု', false, 5, '[
  {"key":"pos_sale","label":"POS Sale","label_mm":"POS ရောင်းအား","type":"money","source":"auto","source_key":"pos_sale"},
  {"key":"daily_sale_report","label":"Daily Sale Report","label_mm":"နေ့စဉ် အစီရင်ခံစာ","type":"money"},
  {"key":"received","label":"Cash / Bank Received","label_mm":"ရရှိငွေ","type":"money"},
  {"key":"credit_sale","label":"Credit Sale","label_mm":"အကြွေး","type":"money"},
  {"key":"variance","label":"Variance","label_mm":"ကွာခြားချက်","type":"money"},
  {"key":"variance_explanation","label":"Variance Explanation","label_mm":"ရှင်းလင်းချက်","type":"textarea"},
  {"key":"reconciled","label":"Reconciled","label_mm":"ညှိပြီး","type":"yesno","required":true}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 6. Inventory Account
-- ---------------------------------------------------------------------

select reporting.seed_section('inventory_daily', 'summary', 'Stock Summary', 'လက်ကျန် အနှစ်ချုပ်', false, 1, '[
  {"key":"total_sku","label":"Total Active SKU","label_mm":"စုစုပေါင်း SKU","type":"number","source":"auto","source_key":"active_sku"},
  {"key":"total_qty","label":"Total Stock Quantity","label_mm":"စုစုပေါင်း ပမာဏ","type":"number","source":"auto","source_key":"total_stock"},
  {"key":"negative_sku","label":"Negative Stock SKU","label_mm":"အနုတ် လက်ကျန်","type":"number","source":"auto","source_key":"negative_stock"},
  {"key":"zero_sku","label":"Zero Stock SKU","label_mm":"သုည လက်ကျန်","type":"number","source":"auto","source_key":"zero_stock"},
  {"key":"low_sku","label":"Low Stock SKU","label_mm":"နည်းနေသော","type":"number","source":"auto","source_key":"low_stock"},
  {"key":"overstock_sku","label":"Overstock SKU","label_mm":"ပိုလျှံ","type":"number"},
  {"key":"adjustment_count","label":"Stock Adjustment Count","label_mm":"ချိန်ညှိမှု","type":"number"},
  {"key":"return_in_count","label":"Return-In Count","label_mm":"ပြန်ဝင်","type":"number"},
  {"key":"return_out_count","label":"Return-Out Count","label_mm":"ပြန်ထွက်","type":"number"},
  {"key":"transfer_pending","label":"Transfer Pending Count","label_mm":"လွှဲပြောင်း ကျန်ရှိ","type":"number","source":"auto","source_key":"transfer_pending"},
  {"key":"system_vs_ground","label":"System vs Ground Difference","label_mm":"စနစ်နှင့် အမှန် ကွာခြား","type":"number"}
]'::jsonb);

select reporting.seed_section('inventory_daily', 'exceptions', 'Stock Exceptions', 'လက်ကျန် ကွာခြားချက်', true, 2, '[
  {"key":"product_code","label":"Product Code","label_mm":"ကုန်ပစ္စည်းကုဒ်"},
  {"key":"product_name","label":"Product Name","label_mm":"ကုန်ပစ္စည်းအမည်"},
  {"key":"location","label":"Location","label_mm":"တည်နေရာ","type":"store"},
  {"key":"system_qty","label":"System Quantity","label_mm":"စနစ် ပမာဏ","type":"number"},
  {"key":"ground_qty","label":"Ground Quantity","label_mm":"အမှန် ပမာဏ","type":"number"},
  {"key":"difference","label":"Difference","label_mm":"ကွာခြား","type":"number"},
  {"key":"difference_value","label":"Difference Value","label_mm":"ကွာခြား တန်ဖိုး","type":"money"},
  {"key":"root_cause","label":"Root Cause","label_mm":"အကြောင်းရင်း"},
  {"key":"action_taken","label":"Action Taken","label_mm":"ဆောင်ရွက်ချက်"},
  {"key":"responsible","label":"Responsible Person","label_mm":"တာဝန်ရှိသူ","type":"user"},
  {"key":"deadline","label":"Deadline","label_mm":"နောက်ဆုံးရက်","type":"date"},
  {"key":"status","label":"Status","label_mm":"အခြေအနေ","type":"select","options":["Open","In Progress","Done"]}
]'::jsonb);

select reporting.seed_section('inventory_daily', 'return_in', 'Return-In / Adjustment', 'ပြန်ဝင် / ချိန်ညှိ', true, 3, '[
  {"key":"date","label":"Date","label_mm":"ရက်စွဲ","type":"date"},
  {"key":"channel","label":"Channel","label_mm":"ချန်နယ်","type":"select","options":["Retail","Online","Wholesale"]},
  {"key":"invoice_no","label":"Invoice No.","label_mm":"ငွေတောင်းခံလွှာ"},
  {"key":"product","label":"Product","label_mm":"ကုန်ပစ္စည်း"},
  {"key":"quantity","label":"Quantity","label_mm":"ပမာဏ","type":"number"},
  {"key":"reason","label":"Reason","label_mm":"အကြောင်းရင်း"},
  {"key":"warehouse_verified","label":"Warehouse Verification","label_mm":"ဂိုဒေါင် အတည်ပြု","type":"yesno"},
  {"key":"accountant_approved","label":"Inventory Accountant Approval","label_mm":"စာရင်းကိုင် အတည်ပြု","type":"yesno"},
  {"key":"ar_notified","label":"AR Notification","label_mm":"AR အသိပေး","type":"yesno"},
  {"key":"return_in_no","label":"Return-In No.","label_mm":"Return-In နံပါတ်"},
  {"key":"stock_updated","label":"Stock Updated","label_mm":"လက်ကျန် ပြင်ပြီး","type":"yesno"},
  {"key":"evidence","label":"Evidence","label_mm":"အထောက်အထား","type":"file"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 7. Sales Manager
-- ---------------------------------------------------------------------

select reporting.seed_section('sales_daily', 'by_channel', 'By Channel / Branch', 'ချန်နယ် / ဆိုင်အလိုက်', true, 1, '[
  {"key":"channel","label":"Channel / Branch","label_mm":"ချန်နယ် / ဆိုင်","type":"store"},
  {"key":"daily_target","label":"Daily Target","label_mm":"နေ့စဉ် ပန်းတိုင်","type":"money"},
  {"key":"actual_sale","label":"Actual Sale","label_mm":"အမှန်တကယ်","type":"money","source":"auto","source_key":"total_sale"},
  {"key":"achievement_pct","label":"Achievement %","label_mm":"ပြည့်မီမှု %","type":"percent"},
  {"key":"invoice_count","label":"Invoice Count","label_mm":"ဘေလ် အရေအတွက်","type":"number","source":"auto","source_key":"invoice_count"},
  {"key":"avg_invoice","label":"Average Invoice Value","label_mm":"ပျမ်းမျှ ဘေလ်","type":"money","source":"auto","source_key":"avg_invoice"},
  {"key":"customer_entrance","label":"Customer Entrance","label_mm":"ဝင်လာသူ","type":"number"},
  {"key":"conversion_rate","label":"Conversion Rate","label_mm":"ဝယ်ယူမှုနှုန်း","type":"percent"},
  {"key":"credit_sale","label":"Credit Sale","label_mm":"အကြွေး","type":"money"},
  {"key":"return_count","label":"Return / Error Count","label_mm":"ပြန်အမ်း","type":"number","source":"auto","source_key":"return_count"},
  {"key":"stockout_product","label":"Stock-out Product","label_mm":"ကုန်သွားသော ပစ္စည်း"},
  {"key":"lost_sale","label":"Estimated Lost Sale","label_mm":"ဆုံးရှုံး ရောင်းအား","type":"money"},
  {"key":"staff_issue","label":"Staff Issue","label_mm":"ဝန်ထမ်း ကိစ္စ"},
  {"key":"action_plan","label":"Action Plan","label_mm":"လုပ်ဆောင်ရန်"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 8. Wholesale
-- ---------------------------------------------------------------------

select reporting.seed_section('wholesale_daily', 'summary', 'Wholesale Summary', 'လက်ကား အနှစ်ချုပ်', false, 1, '[
  {"key":"daily_target","label":"Daily Target","label_mm":"နေ့စဉ် ပန်းတိုင်","type":"money"},
  {"key":"actual_sale","label":"Actual Sale","label_mm":"အမှန်တကယ်","type":"money","source":"auto","source_key":"wholesale_sale"},
  {"key":"new_dealer","label":"New Dealer Count","label_mm":"ကိုယ်စားလှယ်သစ်","type":"number"},
  {"key":"active_dealer","label":"Active Dealer Count","label_mm":"လက်ရှိ ကိုယ်စားလှယ်","type":"number"},
  {"key":"order_count","label":"Order Count","label_mm":"အော်ဒါ","type":"number"},
  {"key":"order_value","label":"Order Value","label_mm":"အော်ဒါ တန်ဖိုး","type":"money"},
  {"key":"cash_sale","label":"Cash Sale","label_mm":"ငွေသား","type":"money"},
  {"key":"credit_sale","label":"Credit Sale","label_mm":"အကြွေး","type":"money"},
  {"key":"collection","label":"Collection Amount","label_mm":"ကောက်ခံရရှိ","type":"money"},
  {"key":"outstanding","label":"Outstanding Amount","label_mm":"ကျန်ရှိ","type":"money"},
  {"key":"pending_order","label":"Pending Order","label_mm":"ကျန်ရှိ အော်ဒါ","type":"number"},
  {"key":"cancelled_order","label":"Cancelled Order","label_mm":"ပယ်ဖျက် အော်ဒါ","type":"number"},
  {"key":"stockout_item","label":"Stock-out Item","label_mm":"ကုန်သွားသော ပစ္စည်း"},
  {"key":"return_qty","label":"Return / Error Quantity","label_mm":"ပြန်အမ်း ပမာဏ","type":"number"},
  {"key":"dealer_complaint","label":"Dealer Complaint","label_mm":"ကိုယ်စားလှယ် တိုင်ကြားမှု","type":"textarea"},
  {"key":"followup","label":"Follow-up Needed","label_mm":"ဆက်လက် ဆောင်ရွက်ရန်","type":"textarea"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- 9. Digital Marketing
-- ---------------------------------------------------------------------

select reporting.seed_section('marketing_daily', 'platforms', 'Platform Activity', 'ပလက်ဖောင်း', true, 1, '[
  {"key":"platform","label":"Platform / Page","label_mm":"ပလက်ဖောင်း"},
  {"key":"content_target","label":"Content Target","label_mm":"ပန်းတိုင်","type":"number"},
  {"key":"content_posted","label":"Content Posted","label_mm":"တင်ပြီး","type":"number"},
  {"key":"content_type","label":"Content Type","label_mm":"အမျိုးအစား"},
  {"key":"campaign","label":"Campaign Name","label_mm":"ကမ်ပိန်း"},
  {"key":"ad_spend","label":"Ad Spend","label_mm":"ကြော်ငြာစရိတ်","type":"money"},
  {"key":"reach","label":"Reach","label_mm":"ရောက်ရှိမှု","type":"number"},
  {"key":"engagement","label":"Engagement","label_mm":"တုံ့ပြန်မှု","type":"number"},
  {"key":"leads","label":"Message / Lead","label_mm":"စာ / Lead","type":"number"},
  {"key":"orders","label":"Order","label_mm":"အော်ဒါ","type":"number"},
  {"key":"sale_amount","label":"Sale Amount","label_mm":"ရောင်းရငွေ","type":"money"},
  {"key":"roas","label":"ROAS","type":"number"},
  {"key":"pending_content","label":"Pending Content","label_mm":"ကျန်ရှိ"},
  {"key":"delay_reason","label":"Delay Reason","label_mm":"နောက်ကျရသည့် အကြောင်း"},
  {"key":"responsible","label":"Responsible Person","label_mm":"တာဝန်ရှိသူ","type":"user"},
  {"key":"deadline","label":"Deadline","label_mm":"နောက်ဆုံးရက်","type":"date"}
]'::jsonb);

-- ---------------------------------------------------------------------
-- Common to every form: the closing narrative and the day ahead.
-- Seeded last so it sorts to the bottom of each one.
-- ---------------------------------------------------------------------

do $$
declare
  v_form text;
begin
  foreach v_form in array array[
    'hr_daily', 'warehouse_daily', 'merchandising_daily', 'cash_daily',
    'inventory_daily', 'sales_daily', 'wholesale_daily', 'marketing_daily'
  ] loop
    perform reporting.seed_section(v_form, 'closing', 'Summary', 'အနှစ်ချုပ်', false, 90, '[
      {"key":"completed_actions","label":"Completed Actions","label_mm":"ပြီးစီးသော အလုပ်","type":"textarea"},
      {"key":"urgent_issues","label":"Urgent Issues","label_mm":"အရေးပေါ် ကိစ္စ","type":"textarea"},
      {"key":"special_incidents","label":"Special Incidents","label_mm":"ထူးခြားဖြစ်စဉ်","type":"textarea"},
      {"key":"suggestions","label":"Suggestions","label_mm":"အကြံပြုချက်","type":"textarea"},
      {"key":"tomorrow_priorities","label":"Tomorrow''s Priorities","label_mm":"မနက်ဖြန် ဦးစားပေး","type":"textarea"}
    ]'::jsonb);
  end loop;
end $$;
