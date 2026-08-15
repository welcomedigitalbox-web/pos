-- ============================================
-- Marketing campaigns and daily ad spend.
--   * Works immediately with manual entry
--   * Same tables are filled by the Meta/TikTok sync once tokens exist,
--     so nothing has to be rebuilt later
-- ============================================

create table if not exists ad_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('meta','tiktok')),
  name text not null,
  account_id text,           -- e.g. act_123456789
  access_token text,         -- system user token; null until approval comes through
  is_active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz default now()
);
alter table ad_accounts enable row level security;
drop policy if exists "authenticated read/write - ad_accounts" on ad_accounts;
create policy "authenticated read/write - ad_accounts" on ad_accounts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create table if not exists ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid references ad_accounts(id) on delete set null,
  platform text not null check (platform in ('meta','tiktok','other')),
  -- The platform's own id, so a re-sync updates rather than duplicates
  external_id text,
  name text not null,
  objective text,
  start_date date not null,
  end_date date,
  budget numeric not null default 0,
  -- Ties a campaign to the coupon or channel it drove, for attribution later
  coupon_code text,
  store_id text,
  note text,
  created_by text,
  created_at timestamptz default now()
);
create unique index if not exists idx_ad_campaigns_external
  on ad_campaigns(platform, external_id) where external_id is not null;
alter table ad_campaigns enable row level security;
drop policy if exists "authenticated read/write - ad_campaigns" on ad_campaigns;
create policy "authenticated read/write - ad_campaigns" on ad_campaigns
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- One row per campaign per day: the shape both platforms report in
create table if not exists ad_daily_stats (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references ad_campaigns(id) on delete cascade,
  stat_date date not null,
  spend numeric not null default 0,
  impressions numeric not null default 0,
  clicks numeric not null default 0,
  reach numeric not null default 0,
  created_at timestamptz default now(),
  unique (campaign_id, stat_date)
);
create index if not exists idx_ad_daily_stats_date on ad_daily_stats(stat_date);
alter table ad_daily_stats enable row level security;
drop policy if exists "authenticated read/write - ad_daily_stats" on ad_daily_stats;
create policy "authenticated read/write - ad_daily_stats" on ad_daily_stats
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
