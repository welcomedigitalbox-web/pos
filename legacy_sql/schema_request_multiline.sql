-- ============================================
-- One request can now cover many products, like a PO.
-- Lines that belong together share a request_no.
-- ============================================
alter table stock_requests add column if not exists request_no text;

-- Existing single-line requests each become their own request
update stock_requests
set request_no = 'SR-' || substr(id::text, 1, 8)
where request_no is null;

create index if not exists idx_stock_requests_no on stock_requests(request_no);
