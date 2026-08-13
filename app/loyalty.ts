import { LoyaltyTier } from "@/lib/supabase";

export function findTier(tiers: LoyaltyTier[], tierId: string | null | undefined): LoyaltyTier | null {
  if (!tierId) return null;
  return tiers.find((t) => t.id === tierId) || null;
}

export function tierDiscountPercent(tiers: LoyaltyTier[], tierId: string | null | undefined): number {
  return findTier(tiers, tierId)?.discount_percent ?? 0;
}
