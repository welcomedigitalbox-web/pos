-- ============================================
-- A cash refund still leaves the till through a specific tender
-- (cash, KPay, bank...). Recording it keeps refunds reconcilable against
-- the cash drawer and the daily payment-method totals.
-- ============================================
alter table sale_returns add column if not exists refund_payment_method text;
