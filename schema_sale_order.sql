-- ============================================
-- Sale Order (Online Sale / Wholesale delivery workflow)
-- ============================================
alter table sales add column if not exists order_type text not null default 'walk_in'
  check (order_type in ('walk_in','online','wholesale'));
alter table sales add column if not exists order_status text not null default 'completed'
  check (order_status in ('pending','processing','delivered','cancelled','completed'));
alter table sales add column if not exists delivery_address text;

create index idx_sales_order_status on sales(order_type, order_status);
