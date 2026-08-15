-- ============================================
-- Payment / Discount / VAT / Advance setup
-- schema.sql + schema_auth.sql + schema_costing.sql run ပြီးမှ ဒါကို run ပါ
-- ============================================

alter table sales add column if not exists payment_method text not null default 'cash'
  check (payment_method in ('cash','card','bank_transfer','cod'));
alter table sales add column if not exists subtotal numeric not null default 0;
alter table sales add column if not exists discount_type text default 'flat'
  check (discount_type in ('percent','flat'));
alter table sales add column if not exists discount_value numeric not null default 0;
alter table sales add column if not exists discount_amount numeric not null default 0;
alter table sales add column if not exists vat_percent numeric not null default 0;
alter table sales add column if not exists vat_amount numeric not null default 0;
alter table sales add column if not exists amount_received numeric not null default 0;
alter table sales add column if not exists change_amount numeric not null default 0;
alter table sales add column if not exists advance_payment numeric not null default 0;
alter table sales add column if not exists balance_due numeric not null default 0;
alter table sales add column if not exists note text;
