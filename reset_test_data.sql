-- ============================================================
-- RESET TEST DATA
--
-- Deletes every transaction (sales, stock movements, POs, returns)
-- and zeroes inventory, while KEEPING master data:
--   products, variants, categories, stores, warehouses,
--   suppliers, customers, users, payment methods, loyalty tiers
--
-- ⚠️ THIS CANNOT BE UNDONE. Take a Supabase backup first.
-- ============================================================

begin;

-- Child rows first so foreign keys never block the delete
delete from sale_return_items;
delete from sale_returns;
delete from sale_items;
delete from sales;

delete from stock_transfers;
delete from stock_damages;
delete from stock_requests;

delete from po_payments;
delete from purchase_order_items;
delete from purchase_orders;

-- Batches carry cost history, so they go with the transactions
delete from stock_purchases;

delete from activity_log;

-- Inventory is derived from the movements above; with those gone it must be zero
update store_inventory
set stock_qty = 0,
    avg_cost = 0,
    previous_avg_cost = 0,
    last_purchase_cost = 0,
    updated_at = now();

-- Customer balances came from transactions that no longer exist
update customers set store_credit = 0 where store_credit is not null;

commit;

-- ---- Verify: every count below should be 0 ----
select
  (select count(*) from sales)            as sales,
  (select count(*) from sale_items)       as sale_items,
  (select count(*) from sale_returns)     as returns,
  (select count(*) from stock_purchases)  as batches,
  (select count(*) from stock_transfers)  as transfers,
  (select count(*) from stock_requests)   as requests,
  (select count(*) from purchase_orders)  as purchase_orders,
  (select coalesce(sum(stock_qty), 0) from store_inventory) as total_stock;
