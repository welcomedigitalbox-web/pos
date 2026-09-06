-- =====================================================================
-- A warehouse can read the requests addressed to it
-- Repo path: supabase/migrations/20260906000009_request_warehouse_read.sql
--
-- The read policy tested only store_id, so seeing a request meant covering
-- the shop that raised it. Warehouse staff do not cover shops and should
-- not: they fill orders, they do not sell. The effect was that the people
-- who do the picking could not see what to pick, and the only fix on hand
-- was to grant them scope over every branch - far more than the job needs.
--
-- A request names the warehouse it is asking, so that is the second way in:
-- you may read a request if you cover the shop that raised it, or the
-- warehouse it was sent to.
--
-- Writes are untouched. Staff move requests through the RPCs, which do
-- their own checks; nothing here lets a picker edit a shop's request.
--
-- Idempotent - safe to re-run.
-- =====================================================================

drop policy if exists "read stock_requests" on public.stock_requests;

create policy "read stock_requests"
  on public.stock_requests for select to authenticated
  using (
    public.can_read_store(store_id)
    or (
      requested_warehouse_id is not null
      and public.can_read_store(requested_warehouse_id)
    )
  );
