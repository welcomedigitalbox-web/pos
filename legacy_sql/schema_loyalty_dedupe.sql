-- ============================================
-- Customers/Loyalty Tiers are now shared across ALL stores.
-- This dedupes tiers that were previously seeded once per store
-- (e.g. "Silver" x4, "Gold" x4) down to a single global row per name,
-- and re-points any customers referencing a removed duplicate.
-- ============================================

with ranked as (
  select
    id,
    name,
    row_number() over (partition by lower(name) order by created_at asc) as rn,
    first_value(id) over (partition by lower(name) order by created_at asc) as keep_id
  from loyalty_tiers
)
update customers c
set loyalty_tier_id = r.keep_id
from ranked r
where c.loyalty_tier_id = r.id and r.rn > 1;

delete from loyalty_tiers
where id in (
  select id from (
    select id, row_number() over (partition by lower(name) order by created_at asc) as rn
    from loyalty_tiers
  ) x
  where x.rn > 1
);
