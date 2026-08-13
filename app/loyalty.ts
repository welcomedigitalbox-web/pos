export const LOYALTY_DISCOUNT: Record<string, number> = {
  none: 0,
  silver: 3,
  gold: 5,
};

export function loyaltyDiscountPercent(tier: string | null | undefined): number {
  return LOYALTY_DISCOUNT[tier || "none"] ?? 0;
}

export const LOYALTY_TIER_LABEL: Record<string, { my: string; en: string; color: string }> = {
  none: { my: "-", en: "-", color: "bg-slate-100 text-slate-500" },
  silver: { my: "ငွေအဆင့် (3%)", en: "Silver (3%)", color: "bg-slate-200 text-slate-700" },
  gold: { my: "ရွှေအဆင့် (5%)", en: "Gold (5%)", color: "bg-yellow-100 text-yellow-700" },
};
