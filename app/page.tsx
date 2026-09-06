"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  ShoppingCart,
  Package,
  Tag,
  Factory,
  BarChart3,
  Bot,
  User,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "./auth-context";
import { useLanguage } from "./language-context";
import { PAGE_OPTIONS, GROUP_LABELS, hasPermission } from "./permissions";

// One tile per area of the business. The order is the order of a working
// day: sell, check stock, buy, move, review.
const GROUPS: {
  group: string;
  Icon: LucideIcon;
  tint: string;
}[] = [
  { group: "sale", Icon: ShoppingCart, tint: "bg-blue-50 text-blue-600" },
  { group: "inventory", Icon: Package, tint: "bg-amber-50 text-amber-600" },
  { group: "merchandising", Icon: Tag, tint: "bg-purple-50 text-purple-600" },
  { group: "warehouse", Icon: Factory, tint: "bg-slate-100 text-slate-600" },
  { group: "reports", Icon: BarChart3, tint: "bg-green-50 text-green-600" },
  { group: "ai-agent", Icon: Bot, tint: "bg-indigo-50 text-indigo-600" },
  { group: "profile", Icon: User, tint: "bg-slate-100 text-slate-600" },
];

export default function HomePage() {
  const router = useRouter();
  const { profile, loading } = useAuth();
  const { t } = useLanguage();

  // A tile is worth showing only if the account can open something behind
  // it. Warehouse staff used to land on the till, fail to load it, and be
  // stuck; now they get their own shelf of doors.
  const tiles = useMemo(() => {
    if (!profile) return [];
    return GROUPS.map((g) => {
      const pages = PAGE_OPTIONS.filter(
        (n) => n.group === g.group && hasPermission(profile, n.key)
      );
      return { ...g, pages };
    }).filter((g) => g.pages.length > 0);
  }, [profile]);

  if (loading) {
    return <div className="pt-16 text-center text-sm text-slate-400">…</div>;
  }

  if (!profile) return null;

  return (
    <div className="pt-6 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">
          {t("home_greeting")} {profile.email?.split("@")[0]}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t("home_subtitle")}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {tiles.map(({ group, Icon, tint, pages }) => (
          <button
            key={group}
            // Straight to the first page of the area rather than an
            // intermediate menu: one tap gets you working.
            onClick={() => router.push(pages[0].href)}
            className="bg-white border border-slate-200 rounded-2xl p-5 text-left hover:border-blue-300 hover:shadow-sm transition"
          >
            <div className={`w-12 h-12 rounded-xl grid place-items-center mb-3 ${tint}`}>
              <Icon size={24} strokeWidth={1.75} />
            </div>
            <div className="font-medium">{t(GROUP_LABELS[group as keyof typeof GROUP_LABELS] as any)}</div>
            <div className="text-xs text-slate-400 mt-0.5">
              {pages.length} {t("home_pages")}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
