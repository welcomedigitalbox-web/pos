-- ============================================
-- Auth + Role setup
-- Supabase SQL Editor မှာ run ပါ (schema.sql run ပြီးမှ ဒါကို run ပါ)
-- ============================================

-- 1. Profiles table (role သိမ်းဖို့) — auth.users ကို link
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'cashier' check (role in ('cashier','manager','admin')),
  store_id text default 'SR-BAK',
  created_at timestamptz default now()
);

-- 2. User အသစ် sign up တိုင်း profile auto create (default role = cashier)
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

-- 3. Profiles RLS: user ကိုယ်တိုင်ရဲ့ profile ကိုပဲ ကြည့်ခွင့်ပြု
alter table profiles enable row level security;

create policy "users can view own profile" on profiles
  for select using (auth.uid() = id);

create policy "users can update own profile" on profiles
  for update using (auth.uid() = id);

-- ============================================
-- 4. products/sales/sale_items ရဲ့ RLS ကို "public access" ကနေ
--    "login လုပ်ထားသူပဲ" ဆိုတဲ့ level ကို အနည်းဆုံး ပြောင်းမယ်
-- ============================================
drop policy if exists "public access - products" on products;
drop policy if exists "public access - sales" on sales;
drop policy if exists "public access - sale_items" on sale_items;

create policy "authenticated read/write - products" on products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "authenticated read/write - sales" on sales
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "authenticated read/write - sale_items" on sale_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ============================================
-- 5. Manager/admin user ကို manually create ဖို့ note:
--    Supabase Dashboard -> Authentication -> Users -> Add User
--    (email/password ထည့်ပါ), ပြီးရင် ဒီ SQL run ပြီး role ကို manager လုပ်ပါ:
--
--    update profiles set role = 'manager' where email = 'manager@example.com';
-- ============================================
