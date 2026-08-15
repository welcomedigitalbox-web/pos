-- ============================================
-- Payment Methods are now shared across ALL stores
-- ============================================

-- Allow store_id to be optional now (no longer used for filtering)
alter table payment_methods alter column store_id drop not null;

-- Dedupe: keep one row per unique code (earliest created), drop the rest
-- (these were previously seeded once per store, e.g. 'cash' x4)
delete from payment_methods
where id in (
  select id from (
    select id, row_number() over (partition by lower(code) order by created_at asc) as rn
    from payment_methods
  ) x
  where x.rn > 1
);

-- If a store has zero payment methods (e.g. a freshly-created store before this change),
-- seed the standard defaults once, globally.
insert into payment_methods (name, code, is_cash, is_cod, sort_order)
select * from (values
  ('Cash','cash', true, false, 1),
  ('Card','card', false, false, 2),
  ('Bank Transfer','bank_transfer', false, false, 3),
  ('COD','cod', false, true, 4)
) as m(name, code, is_cash, is_cod, sort_order)
where not exists (select 1 from payment_methods where lower(code) = lower(m.code));
