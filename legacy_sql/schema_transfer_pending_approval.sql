-- ============================================
-- A discrepancy can now wait for a manager instead of forcing a PIN on the spot.
-- Stock is only credited once it is approved, so an unapproved shortage never
-- silently changes inventory.
-- ============================================
alter table stock_transfers drop constraint if exists stock_transfers_status_check;
alter table stock_transfers add constraint stock_transfers_status_check
  check (status in ('in_transit','received','discrepancy','pending_approval'));
