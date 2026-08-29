-- Two corrections to cross-store returns.
--
-- 1. A branch could not see returns it had processed for another store, so
--    the refund it paid out was missing from its own history - and worse,
--    findOrder() read an empty already-returned list and offered the same
--    items for refund a second time.
--
-- 2. A cross-store return where every line is damaged has nothing to send
--    back: the goods are written off where they were handed in. Without a
--    marker the "Send back" button stayed, offering to move stock that does
--    not exist.
--
-- Applied by hand in the SQL editor first; repair history if push conflicts.

alter table public.sale_returns
  add column if not exists no_transfer_needed boolean not null default false;

drop policy if exists "read sale_returns" on public.sale_returns;
create policy "read sale_returns"
  on public.sale_returns for select to authenticated
  using (
    public.can_read_store(store_id)
    or public.can_read_store(processed_store_id)
  );

drop policy if exists "read sale_return_items" on public.sale_return_items;
create policy "read sale_return_items"
  on public.sale_return_items for select to authenticated
  using (exists (
    select 1 from public.sale_returns r
    where r.id = sale_return_items.return_id
      and (public.can_read_store(r.store_id)
           or public.can_read_store(r.processed_store_id))
  ));
