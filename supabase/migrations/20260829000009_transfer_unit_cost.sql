-- Stock transfers carry the sending store's cost.
--
-- The receiving store cannot read the warehouse's store_inventory row - RLS
-- scopes that table - so the cost lookup on receipt returned null and stock
-- landed at zero cost. Every sale from transferred stock then showed 100%
-- margin, and COGS across the business read zero.
--
-- Stamping the cost onto the transfer makes it travel with the goods.
--
-- Applied by hand in the SQL editor first; repair history if push conflicts.

alter table public.stock_transfers
  add column if not exists unit_cost numeric not null default 0;

update public.stock_transfers st
set unit_cost = si.avg_cost
from public.store_inventory si
where si.store_id = st.from_store_id
  and si.product_id = st.product_id
  and si.variant_id is not distinct from st.variant_id
  and st.unit_cost = 0
  and si.avg_cost > 0;
