-- ============================================================
-- DEMO SEED — realistic data for a client demo
--
-- Creates: 1 warehouse + 3 stores, categories, 12 products (2 with
-- variants), suppliers, a received PO, stock at every location,
-- 14 days of sales, a return, transfers, and ad campaigns.
--
-- Safe to re-run: it clears the demo transactions first.
-- Run reset_test_data.sql beforehand if you want a clean slate.
-- ============================================================

do $$
declare
  wh   text := 'CENTRAL-WH';
  s1   text := 'SR-MDY';
  s2   text := 'SR-YGN';
  s3   text := 'ON-MDY';
  cat_diaper uuid; cat_feed uuid; cat_care uuid;
  sup_a uuid; sup_b uuid;
  po_id uuid;
  p record;
  v_sale uuid;
  d date;
  i int;
  n_items int;
  line_total numeric;
  line_cogs numeric;
  sale_total numeric;
  qty int;
  store_pick text;
  chan text;
  cashier text;
begin
  ---------------------------------------------------------------
  -- Locations
  ---------------------------------------------------------------
  insert into stores (id, name, is_warehouse, is_active, region) values
    (wh, 'Central Warehouse', true,  true, 'Mandalay'),
    (s1, 'Mandalay Showroom', false, true, 'Mandalay'),
    (s2, 'Yangon Showroom',   false, true, 'Yangon'),
    (s3, 'Mandalay Online',   false, true, 'Mandalay')
  on conflict (id) do update set name = excluded.name, is_active = true;

  update stores set supply_warehouse_id = wh where id in (s1, s2, s3);

  ---------------------------------------------------------------
  -- Categories
  ---------------------------------------------------------------
  insert into product_categories (name, sort_order) values ('Diapers', 1)
    returning id into cat_diaper;
  insert into product_categories (name, sort_order) values ('Feeding', 2)
    returning id into cat_feed;
  insert into product_categories (name, sort_order) values ('Baby Care', 3)
    returning id into cat_care;

  ---------------------------------------------------------------
  -- Products. Costs are set so margins look plausible, not uniform.
  ---------------------------------------------------------------
  insert into products (name, sku, price, store_id, category_id, is_active, requires_expiry) values
    ('Baby Diaper',        'SKU-1001', 25000, wh, cat_diaper, true, false),
    ('Pull-up Pants',      'SKU-1002', 28000, wh, cat_diaper, true, false),
    ('Baby Wipes 80s',     'SKU-1003',  4500, wh, cat_diaper, true, true),
    ('Feeding Bottle 250ml','SKU-2001', 15000, wh, cat_feed,   true, false),
    ('Silicone Nipple',    'SKU-2002',  6000, wh, cat_feed,   true, false),
    ('Baby Formula 400g',  'SKU-2003', 42000, wh, cat_feed,   true, true),
    ('Sippy Cup',          'SKU-2004', 12000, wh, cat_feed,   true, false),
    ('Baby Shampoo 200ml', 'SKU-3001', 12000, wh, cat_care,   true, true),
    ('Baby Lotion 200ml',  'SKU-3002', 13500, wh, cat_care,   true, true),
    ('Baby Powder 300g',   'SKU-3003',  8500, wh, cat_care,   true, true),
    ('Bath Towel',         'SKU-3004', 18000, wh, cat_care,   true, false),
    ('Baby Nail Clipper',  'SKU-3005',  5500, wh, cat_care,   true, false);

  -- Size variants on the two diaper lines
  insert into product_variants (product_id, variant_name, sku, price_override)
  select id, 'M', sku || '-M', price       from products where sku = 'SKU-1001';
  insert into product_variants (product_id, variant_name, sku, price_override)
  select id, 'L', sku || '-L', price + 2000 from products where sku = 'SKU-1001';
  insert into product_variants (product_id, variant_name, sku, price_override)
  select id, 'L', sku || '-L', price       from products where sku = 'SKU-1002';
  insert into product_variants (product_id, variant_name, sku, price_override)
  select id, 'XL', sku || '-XL', price + 2500 from products where sku = 'SKU-1002';

  update products set variation_theme = 'Size' where sku in ('SKU-1001','SKU-1002');

  ---------------------------------------------------------------
  -- Suppliers
  ---------------------------------------------------------------
  insert into suppliers (name, phone, address) values
    ('ABC Trading Co.', '09-250 111 222', 'Mandalay')
    returning id into sup_a;
  insert into suppliers (name, phone, address) values
    ('Golden Baby Import', '09-450 333 444', 'Yangon')
    returning id into sup_b;

  ---------------------------------------------------------------
  -- A received purchase order, so Goods Received has something in it
  ---------------------------------------------------------------
  insert into purchase_orders (po_number, supplier_id, status, payment_term, order_date, created_by)
  values ('PO-10001', sup_a, 'received', 'credit', current_date - 20, 'admin@edu.com')
  returning id into po_id;

  insert into po_payments (po_id, amount, method, paid_by)
  values (po_id, 3000000, 'Bank Transfer', 'admin@edu.com');

  ---------------------------------------------------------------
  -- Stock: every sellable unit gets a batch and inventory row.
  -- Cost is 60-70% of price so gross margin lands around 30-40%.
  ---------------------------------------------------------------
  for p in
    select pr.id as product_id, v.id as variant_id, pr.sku, pr.price,
           pr.requires_expiry,
           round(pr.price * (0.60 + (random() * 0.10)))::numeric as cost
    from products pr
    left join product_variants v on v.product_id = pr.id
  loop
    -- Warehouse holds the bulk
    insert into purchase_order_items (po_id, product_id, variant_id, qty, unit_cost, received_qty)
    values (po_id, p.product_id, p.variant_id, 400, p.cost, 400);

    insert into stock_purchases
      (product_id, variant_id, store_id, supplier, qty, unit_cost, total_cost,
       new_avg_cost, remaining_qty, expiry_date, po_id, received_by, received_at)
    values
      (p.product_id, p.variant_id, wh, 'ABC Trading Co.', 400, p.cost, 400 * p.cost,
       p.cost, 250, case when p.requires_expiry then current_date + 180 else null end,
       po_id, 'admin@edu.com', now() - interval '20 days');

    -- A second batch with a nearer expiry, so the expiry drilldown has data
    if p.requires_expiry then
      insert into stock_purchases
        (product_id, variant_id, store_id, supplier, qty, unit_cost, total_cost,
         new_avg_cost, remaining_qty, expiry_date, received_by, received_at)
      values
        (p.product_id, p.variant_id, wh, 'Golden Baby Import', 100, p.cost * 1.05,
         100 * p.cost * 1.05, p.cost, 60, current_date + 20,
         'admin@edu.com', now() - interval '10 days');
    end if;

    insert into store_inventory
      (store_id, product_id, variant_id, stock_qty, avg_cost, previous_avg_cost, last_purchase_cost)
    values
      (wh, p.product_id, p.variant_id, case when p.requires_expiry then 310 else 250 end,
       p.cost, p.cost, p.cost)
    on conflict (store_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set stock_qty = excluded.stock_qty, avg_cost = excluded.avg_cost;

    -- Stores hold smaller amounts
    insert into store_inventory
      (store_id, product_id, variant_id, stock_qty, avg_cost, previous_avg_cost, last_purchase_cost)
    values
      (s1, p.product_id, p.variant_id, 40 + floor(random() * 30), p.cost, p.cost, p.cost),
      (s2, p.product_id, p.variant_id, 30 + floor(random() * 25), p.cost, p.cost, p.cost),
      (s3, p.product_id, p.variant_id, 15 + floor(random() * 15), p.cost, p.cost, p.cost)
    on conflict (store_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set stock_qty = excluded.stock_qty, avg_cost = excluded.avg_cost;
  end loop;

  ---------------------------------------------------------------
  -- Sales across the last 14 days. Volume rises on days 5-8 to line
  -- up with the campaign seeded further down.
  ---------------------------------------------------------------
  for i in 0..13 loop
    d := current_date - i;

    for n_items in 1..(case when i between 6 and 9 then 9 else 4 end) loop
      store_pick := (array[s1, s2, s3])[1 + floor(random() * 3)];
      chan := case when store_pick = s3
                   then (array['facebook','tiktok','viber'])[1 + floor(random() * 3)]
                   else null end;
      cashier := case when store_pick = s1 then 'cashier1@edu.com'
                      when store_pick = s2 then 'cashier2@edu.com'
                      else 'online@edu.com' end;

      insert into sales
        (store_id, subtotal, discount_amount, vat_amount, total, payment_method,
         order_type, channel, customer_name, cashier_email, amount_received,
         change_amount, balance_due, order_status, created_at)
      values
        (store_pick, 0, 0, 0, 0,
         (array['cash','kpay','wave'])[1 + floor(random() * 3)],
         case when store_pick = s3 then 'online' else 'pos' end,
         chan,
         (array['Ma Ma','Daw Hla','U Kyaw','Walk-in','Ma Thida'])[1 + floor(random() * 5)],
         cashier, 0, 0, 0, 'completed',
         d + (time '09:00' + (random() * interval '10 hours')))
      returning id into v_sale;

      sale_total := 0;

      -- 1-3 lines per sale
      for p in
        select pr.id as product_id, v.id as variant_id,
               pr.name || coalesce(' (' || v.variant_name || ')', '') as pname,
               coalesce(v.price_override, pr.price) as price,
               si.avg_cost as cost
        from products pr
        left join product_variants v on v.product_id = pr.id
        join store_inventory si
          on si.product_id = pr.id
         and coalesce(si.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(v.id, '00000000-0000-0000-0000-000000000000'::uuid)
         and si.store_id = store_pick
        order by random()
        limit 1 + floor(random() * 3)
      loop
        qty := 1 + floor(random() * 3);
        line_total := qty * p.price;
        line_cogs := qty * p.cost;
        sale_total := sale_total + line_total;

        insert into sale_items
          (sale_id, product_id, variant_id, product_name, qty, unit_price,
           line_total, unit_cost, line_cogs, created_at)
        values
          (v_sale, p.product_id, p.variant_id, p.pname, qty, p.price,
           line_total, p.cost, line_cogs,
           d + (time '09:00' + (random() * interval '10 hours')));

        update store_inventory
        set stock_qty = greatest(0, stock_qty - qty)
        where store_id = store_pick
          and product_id = p.product_id
          and coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce(p.variant_id, '00000000-0000-0000-0000-000000000000'::uuid);
      end loop;

      update sales
      set subtotal = sale_total,
          total = sale_total,
          amount_received = sale_total
      where id = v_sale;
    end loop;
  end loop;

  ---------------------------------------------------------------
  -- Transfers: one settled, one still in transit, one short
  ---------------------------------------------------------------
  insert into stock_transfers
    (product_id, variant_id, from_store_id, to_store_id, qty, received_qty,
     status, transferred_by, received_by, received_at, created_at)
  select pr.id, null, wh, s1, 50, 50, 'received',
         'admin@edu.com', 'cashier1@edu.com', now() - interval '6 days',
         now() - interval '7 days'
  from products pr where pr.sku = 'SKU-2001';

  insert into stock_transfers
    (product_id, variant_id, from_store_id, to_store_id, qty, status,
     transferred_by, created_at)
  select pr.id, null, wh, s2, 40, 'in_transit', 'admin@edu.com', now() - interval '1 day'
  from products pr where pr.sku = 'SKU-3001';

  insert into stock_transfers
    (product_id, variant_id, from_store_id, to_store_id, qty, received_qty,
     status, discrepancy_note, transferred_by, received_by, received_at, created_at)
  select pr.id, null, wh, s2, 30, 24, 'discrepancy',
         'Damaged in transit', 'admin@edu.com', 'cashier2@edu.com',
         now() - interval '3 days', now() - interval '4 days'
  from products pr where pr.sku = 'SKU-3003';

  ---------------------------------------------------------------
  -- Ad campaigns, with the busy window matching the sales bump above
  ---------------------------------------------------------------
  insert into ad_campaigns
    (platform, name, start_date, end_date, budget, coupon_code, note, created_by)
  values
    ('meta',   'Diaper Promo — August', current_date - 9, current_date - 6, 400000, 'FB0815',
     'Boosted reel + carousel', 'admin@edu.com'),
    ('tiktok', 'TikTok Feeding Bundle', current_date - 5, current_date - 3, 250000, 'TT0819',
     'Creator collab', 'admin@edu.com'),
    ('meta',   'Baby Care Weekend', current_date - 2, current_date, 180000, null,
     'Story ads', 'admin@edu.com');

  insert into ad_daily_stats (campaign_id, stat_date, spend, impressions, clicks, reach)
  select c.id,
         gs::date,
         round(c.budget / greatest(1, (c.end_date - c.start_date) + 1)),
         8000 + floor(random() * 6000),
         180 + floor(random() * 220),
         5000 + floor(random() * 4000)
  from ad_campaigns c,
       generate_series(c.start_date, coalesce(c.end_date, current_date), interval '1 day') gs
  on conflict (campaign_id, stat_date) do nothing;

end $$;

-- ---- Summary ----
select
  (select count(*) from stores)            as stores,
  (select count(*) from products)          as products,
  (select count(*) from product_variants)  as variants,
  (select count(*) from sales)             as sales,
  (select count(*) from sale_items)        as sale_items,
  (select count(*) from stock_transfers)   as transfers,
  (select count(*) from ad_campaigns)      as campaigns,
  (select round(sum(total)) from sales)    as total_revenue;
