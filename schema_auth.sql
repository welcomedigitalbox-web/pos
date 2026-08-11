-- ============================================
-- Auth + Role setup
-- Supabase SQL Editor မှာ run ပါ (schema.sql run ပြီးမှ ဒါကို run ပါ)
-- ============================================

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'cashier' check (role in ('cashier','manager','admin')),
  store_id text default 'SR-BAK',
  created_at timestamptz default now()
);

create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table profiles enable row level security;

create policy "users can view own profile" on profiles
  for select using (auth.uid() = id);

create policy "users can update own profile" on profiles
  for update using (auth.uid() = id);

drop policy if exists "public access - products" on products;
drop policy if exists "public access - sales" on sales;
drop policy if exists "public access - sale_items" on sale_items;

create policy "authenticated read/write - products" on products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "authenticated read/write - sales" on sales
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "authenticated read/write - sale_items" on sale_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Manager user create ပြီးရင် ဒီ line ကို run (email ပြောင်းပါ):
-- update profiles set role = 'manager' where email = 'manager@example.com';
