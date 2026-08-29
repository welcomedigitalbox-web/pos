-- Returns now carry the receipt reference they were filed against.
--
-- Joining sales for it does not work: RLS scopes that table, so a branch
-- processing another store's return would read null. Copying the value at
-- creation keeps it visible wherever the return is.
--
-- submit_sale_return is recreated to write it. Applied by hand in the SQL
-- editor first; repair history if push conflicts.

alter table public.sale_returns
  add column if not exists sale_ref text;

update public.sale_returns r
set sale_ref = s.sale_ref
from public.sales s
where s.id = r.original_sale_id and r.sale_ref is null;
