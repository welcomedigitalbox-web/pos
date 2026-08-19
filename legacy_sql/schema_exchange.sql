-- ============================================
-- Exchange rebuilt properly; store credit dropped.
--   * sale_return_items now carries BOTH directions:
--       line_type 'return'   = goods coming back from the customer
--       line_type 'exchange' = replacement goods going out
--   * refund_amount = value returned − value given out
--       positive → shop refunds the difference
--       negative → customer pays the difference
-- ============================================

alter table sale_return_items add column if not exists line_type text not null default 'return'
  check (line_type in ('return','exchange'));

-- Replacement goods leave stock, so the exchange needs a real sale behind it;
-- this links the two so reports stay consistent.
alter table sale_returns add column if not exists exchange_sale_id uuid references sales(id);

-- Store credit is no longer offered
alter table sale_returns drop constraint if exists sale_returns_refund_method_check;
update sale_returns set refund_method = 'cash' where refund_method = 'store_credit';
alter table sale_returns add constraint sale_returns_refund_method_check
  check (refund_method in ('cash','exchange'));
