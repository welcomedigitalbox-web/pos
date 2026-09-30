"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, Customer, LoyaltyTier } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";
import { findTier } from "../loyalty";

type Loyalty = {
  customer_id: string;
  stickers_earned: number;
  stickers_used: number;
  points_earned: number;
  points_used: number;
};

type Programme = "all" | "member" | "stickers" | "points";

export default function CustomersPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [loyalty, setLoyalty] = useState<Map<string, Loyalty>>(new Map());
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");

  // Programme filter, and the sub-filter that belongs to whichever is chosen.
  const [programme, setProgramme] = useState<Programme>("all");
  const [tierPick, setTierPick] = useState<"any" | "none" | string>("any");
  const [minStickers, setMinStickers] = useState(0);
  const [minPoints, setMinPoints] = useState(0);

  useEffect(() => {
    if (profile && !hasPermission(profile, "customers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    loadTiers();
    loadLoyalty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "customers")) return null;

  async function load() {
    const { data } = await supabase.from("customers").select("*").order("name");
    setCustomers(data || []);
  }

  async function loadTiers() {
    const { data } = await supabase.from("loyalty_tiers").select("*").order("sort_order");
    setTiers(data || []);
  }

  // The card standings live beside the customer, so the list can filter on them.
  async function loadLoyalty() {
    const { data } = await supabase
      .from("customer_loyalty")
      .select("customer_id, stickers_earned, stickers_used, points_earned, points_used");
    const m = new Map<string, Loyalty>();
    for (const r of (data || []) as Loyalty[]) m.set(r.customer_id, r);
    setLoyalty(m);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function handleDelete(id: string) {
    if (!confirm(t("customers_deleteConfirm"))) return;
    const { error } = await supabase.from("customers").delete().eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("customers_deleted"));
    await load();
  }

  function stickersOf(id: string) {
    const l = loyalty.get(id);
    return l ? Math.max(l.stickers_earned - l.stickers_used, 0) : 0;
  }
  function pointsOf(id: string) {
    const l = loyalty.get(id);
    return l ? Math.max(l.points_earned - l.points_used, 0) : 0;
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (q) {
        const hit =
          c.name.toLowerCase().includes(q) ||
          (c.phone || "").includes(search.trim()) ||
          (c.email || "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      if (programme === "member") {
        if (tierPick === "none") return !c.loyalty_tier_id;
        if (tierPick === "any") return !!c.loyalty_tier_id;
        return c.loyalty_tier_id === tierPick;
      }
      if (programme === "stickers") return stickersOf(c.id) >= minStickers;
      if (programme === "points") return pointsOf(c.id) >= minPoints;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, loyalty, search, programme, tierPick, minStickers, minPoints]);

  const chip = (on: boolean) =>
    "px-3 py-1.5 rounded-full text-xs font-medium border " +
    (on ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200");

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("nav_customers")}</h2>
        <Link href="/customers/new" className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("customers_addNew")}
        </Link>
      </div>

      <input
        className="w-full sm:w-80 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
        placeholder={t("pos_customerSearchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Programme, then whatever that programme is measured in. */}
      <div className="flex flex-wrap gap-2 mb-2">
        {([
          ["all", "All"],
          ["member", "Member card"],
          ["stickers", "Stickers"],
          ["points", "Mom Love"],
        ] as [Programme, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => {
              setProgramme(key);
              setTierPick("any");
              setMinStickers(key === "stickers" ? 1 : 0);
              setMinPoints(key === "points" ? 1 : 0);
            }}
            className={chip(programme === key)}
          >
            {label}
          </button>
        ))}
      </div>

      {programme === "member" && (
        <div className="flex flex-wrap gap-2 mb-3">
          <button onClick={() => setTierPick("any")} className={chip(tierPick === "any")}>
            Any card
          </button>
          {tiers.map((tr) => (
            <button key={tr.id} onClick={() => setTierPick(tr.id)} className={chip(tierPick === tr.id)}>
              {tr.name} ({tr.discount_percent}%)
            </button>
          ))}
          <button onClick={() => setTierPick("none")} className={chip(tierPick === "none")}>
            No card
          </button>
        </div>
      )}

      {programme === "stickers" && (
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {minStickers}+ stickers
          </span>
          <input
            type="range"
            min={0}
            max={10}
            value={minStickers}
            onChange={(e) => setMinStickers(Number(e.target.value))}
            className="w-56"
          />
          <button onClick={() => setMinStickers(10)} className={chip(minStickers === 10)}>
            Ready to redeem (10)
          </button>
        </div>
      )}

      {programme === "points" && (
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs text-slate-500 whitespace-nowrap">{minPoints}+ points</span>
          <input
            type="range"
            min={0}
            max={5}
            value={minPoints}
            onChange={(e) => setMinPoints(Number(e.target.value))}
            className="w-56"
          />
          <button onClick={() => setMinPoints(5)} className={chip(minPoints === 5)}>
            Ready to redeem (5)
          </button>
        </div>
      )}

      <p className="text-xs text-slate-400 mb-3">{filtered.length} / {customers.length}</p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[960px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("customers_name")}</th>
              <th className="text-left px-4 py-2">{t("pos_customerPhone")}</th>
              <th className="text-left px-4 py-2">{t("customers_email")}</th>
              <th className="text-left px-4 py-2">{t("customers_dob")}</th>
              <th className="text-left px-4 py-2">{t("saleOrder_deliveryAddress")}</th>
              <th className="text-left px-4 py-2">{t("customers_loyalty")}</th>
              <th className="text-right px-4 py-2">Stickers</th>
              <th className="text-right px-4 py-2">Points</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const tier = findTier(tiers, c.loyalty_tier_id);
              const st = stickersOf(c.id);
              const pt = pointsOf(c.id);
              return (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium">{c.name}</td>
                  <td className="px-4 py-2 text-slate-600">{c.phone || <span className="text-red-400">missing</span>}</td>
                  <td className="px-4 py-2 text-slate-400">{c.email || "-"}</td>
                  <td className="px-4 py-2 text-slate-400">{c.date_of_birth || "-"}</td>
                  <td className="px-4 py-2 text-slate-400 max-w-[180px] truncate">{c.delivery_address || "-"}</td>
                  <td className="px-4 py-2">
                    {tier ? (
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-700">
                        {tier.name} ({tier.discount_percent}%)
                      </span>
                    ) : (
                      <span className="text-xs text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className={st >= 10 ? "text-green-600 font-semibold" : "text-slate-500"}>{st}</span>
                    <span className="text-slate-300">/10</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className={pt >= 5 ? "text-green-600 font-semibold" : "text-slate-500"}>{pt}</span>
                    <span className="text-slate-300">/5</span>
                  </td>
                  <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                    <Link href={`/customers/${c.id}`} className="text-slate-500 text-xs font-medium">
                      {t("products_view")}
                    </Link>
                    <Link href={`/customers/${c.id}/edit`} className="text-blue-600 text-xs font-medium">
                      {t("products_edit")}
                    </Link>
                    <button onClick={() => handleDelete(c.id)} className="text-red-600 text-xs font-medium">
                      {t("products_delete")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
