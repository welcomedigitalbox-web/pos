-- P0-4: Stop cross-store returns creating the transfer twice.
--
-- approveReturn() opened an in_transit transfer for cross-store returns but
-- never wrote sale_returns.return_transfer_id. The UI shows "Send back"
-- while that column is null, so the operator could run sendBackToOrigin()
-- as well - producing a second transfer AND deducting stock from a store
-- that never held the goods (approveReturn deliberately skips adding them).
--
-- Link transfers to their return and let the database refuse the duplicate.
-- Idempotent.

alter table public.stock_transfers
  add column if not exists sale_return_id uuid references public.sale_returns(id);

-- One transfer per return line. A multi-line return still opens several
-- transfers; a repeated click cannot open the same one twice.
create unique index if not exists uq_stock_transfers_per_return_line
  on public.stock_transfers (sale_return_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where sale_return_id is not null;

create index if not exists idx_stock_transfers_sale_return
  on public.stock_transfers (sale_return_id) where sale_return_id is not null;

-- Backfill: link existing return transfers so the guard covers them too.
update public.stock_transfers st
set sale_return_id = sr.id
from public.sale_returns sr
where st.sale_return_id is null
  and sr.return_transfer_id = st.id;
