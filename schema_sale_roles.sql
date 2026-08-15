-- ============================================
-- Sale department role hierarchy
-- ============================================
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('cashier','manager','admin','owner','sale_manager','online_sale','wholesale'));
