-- ============================================
-- Cross-store returns: bought at one shop, returned at another.
--   store_id            = the store the ORIGINAL SALE belongs to.
--                         Reports subtract the return there, so revenue is
--                         reversed where it was booked.
--   processed_store_id  = the store physically handling the return. Stock goes
--                         back here and the refund leaves this till.
-- ============================================
alter table sale_returns add column if not exists processed_store_id text;

-- Existing returns were handled by the same store that made the sale
update sale_returns set processed_store_id = store_id where processed_store_id is null;

create index if not exists idx_sale_returns_processed on sale_returns(processed_store_id);
