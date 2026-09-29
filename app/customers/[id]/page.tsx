"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, Customer , netLineTotal } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useLanguage } from "../../language-context";
import { hasPermission } from "../../permissions";
import { findTier } from "../../loyalty";
import { LoyaltyTier } from "@/lib/supabase";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type OrderRow = {
  id: string;
  created_at: string;
  store_id: string;
  total: number;
  order_status: string;
  order_type: string;
  items: string;
};

type ItemStat = {
  name: string;
  qty: number;
  spent: number;
};

type LoyaltyCard = {
  tier: string | null;
  discount_percent: number | null;
  stickers_available: number;
  stickers_to_reward: number;
  spend_per_sticker: number;
  points_available: number;
  points_to_reward: number;
  referrals_made: number;
};

export default function CustomerDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { profile } = useAuth();
  const { t } = useLanguage();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [itemStats, setItemStats] = useState<ItemStat[]>([]);

  // The loyalty card. Every change goes through a database function, so the
  // shop, the till and the customer's own card cannot disagree about a sticker.
  const [card, setCard] = useState<LoyaltyCard | null>(null);
  const [amount, setAmount] = useState("");
  const [saleRef, setSaleRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "customers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!profile || !hasPermission(profile, "customers")) return null;

  async function load() {
    const { data: cust } = await supabase.from("customers").select("*").eq("id", id).maybeSingle();
    if (cust) loadCard((cust as { card_token?: string | null }).card_token ?? null);
    if (!cust) {
      setNotFound(true);
      return;
    }
    setCustomer(cust);

    const { data: tierData } = await supabase
      .from("loyalty_tiers")
      .select("*")
      .order("sort_order");
    setTiers(tierData || []);

    const { data: sales } = await supabase
      .from("sales")
      .select("id, created_at, store_id, total, order_status, order_type")
      .eq("customer_id", id)
      .order("created_at", { ascending: false });

    if (!sales || sales.length === 0) {
      setOrders([]);
      setItemStats([]);
      return;
    }

    const saleIds = sales.map((s) => s.id);
    const { data: items } = await supabase
      .from("sale_items")
      .select("sale_id, product_name, qty, line_total, sales!inner(subtotal, discount_amount)")
      .in("sale_id", saleIds);

    const itemsBySale = new Map<string, string[]>();
    const productAgg = new Map<string, { qty: number; spent: number }>();

    for (const item of items || []) {
      const list = itemsBySale.get(item.sale_id) || [];
      list.push(`${item.product_name} x${item.qty}`);
      itemsBySale.set(item.sale_id, list);

      const agg = productAgg.get(item.product_name) || { qty: 0, spent: 0 };
      agg.qty += Number(item.qty);
      agg.spent += netLineTotal(item.line_total, (item as any).sales?.subtotal, (item as any).sales?.discount_amount);
      productAgg.set(item.product_name, agg);
    }

    const orderRows: OrderRow[] = sales.map((s) => ({
      id: s.id,
      created_at: s.created_at,
      store_id: s.store_id,
      total: Number(s.total),
      order_status: s.order_status,
      order_type: s.order_type,
      items: (itemsBySale.get(s.id) || []).join(", "),
    }));
    setOrders(orderRows);

    const stats: ItemStat[] = Array.from(productAgg.entries())
      .map(([name, v]) => ({ name, qty: v.qty, spent: v.spent }))
      .sort((a, b) => b.qty - a.qty);
    setItemStats(stats);
  }

  function say(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function loadCard(token: string | null) {
    if (!token) return;
    const { data, error } = await supabase.rpc("crm_card", { p_token: token });
    if (error) return say("❌ " + error.message);
    setCard(data as LoyaltyCard);
  }

  async function recordSpend() {
    const n = Number(amount);
    if (!n || n <= 0) return say("Enter the bill amount");
    setBusy(true);
    const { error } = await supabase.rpc("crm_record_spend", {
      p_customer_id: id,
      p_amount: n,
      p_sale_ref: saleRef || null,
      p_store_id: customer?.store_id || null,
    });
    setBusy(false);
    if (error) return say("❌ " + error.message);
    setAmount("");
    setSaleRef("");
    say("Saved");
    loadCard((customer as { card_token?: string | null })?.card_token ?? null);
  }

  async function redeem(kind: "stickers" | "points") {
    setBusy(true);
    const { error } = await supabase.rpc(
      kind === "stickers" ? "crm_redeem_stickers" : "crm_redeem_points",
      { p_customer_id: id, p_sale_ref: saleRef || null }
    );
    setBusy(false);
    if (error) return say("❌ " + error.message);
    say(kind === "stickers" ? "10% discount unlocked" : "5,000 Ks discount unlocked");
    loadCard((customer as { card_token?: string | null })?.card_token ?? null);
  }

  if (notFound) {
    return <div className="pt-8 text-center text-slate-400">{t("customers_notFound")}</div>;
  }
  if (!customer) {
    return <div className="pt-8 text-center text-slate-400">...</div>;
  }

  const totalSpent = orders.reduce((s, o) => s + o.total, 0);
  const totalOrders = orders.length;
  const topItem = itemStats[0];
  const tier = findTier(tiers, customer.loyalty_tier_id);

  return (
    <div className="pt-4">
      <Link href="/customers" className="text-sm text-blue-600 mb-2 inline-block">
        ← {t("nav_customers")}
      </Link>

      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">👤</span>
        <h1 className="text-xl font-bold">{customer.name}</h1>
        {tier && (
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-700">
            {tier.name} ({tier.discount_percent}%)
          </span>
        )}
      </div>
      <div className="text-slate-400 text-sm mb-4">
        {customer.phone || "-"} {customer.email && `· ${customer.email}`}
      </div>

      {/* Contact info */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-3 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs text-slate-400 uppercase">{t("customers_dob")}</div>
          <div className="mt-1">{customer.date_of_birth || "-"}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 uppercase">{t("customers_facebook")}</div>
          <div className="mt-1">{customer.facebook || "-"}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 uppercase">{t("customers_tiktok")}</div>
          <div className="mt-1">{customer.tiktok || "-"}</div>
        </div>
        <div className="sm:col-span-3">
          <div className="text-xs text-slate-400 uppercase">{t("saleOrder_deliveryAddress")}</div>
          <div className="mt-1">{customer.delivery_address || "-"}</div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500">{t("customers_totalSpent")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{fmt(totalSpent)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500">{t("customers_totalOrders")}</div>
          <div className="text-lg font-bold mt-1">{totalOrders}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500">{t("customers_topItem")}</div>
          <div className="text-sm font-bold mt-1">{topItem ? `${topItem.name} (x${topItem.qty})` : "-"}</div>
        </div>
      </div>

      {/* Loyalty */}
      {card && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <h3 className="font-semibold mb-3">Loyalty</h3>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">Member card</div>
              <div className="font-semibold">
                {card.tier ? `${card.tier} · ${card.discount_percent}%` : "—"}
              </div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">Stickers</div>
              <div className="font-semibold">{card.stickers_available} / 10</div>
              <div className="text-[11px] text-slate-400">
                one per {card.spend_per_sticker.toLocaleString()} Ks bill
              </div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-xs text-slate-500">Mom Love points</div>
              <div className="font-semibold">{card.points_available} / 5</div>
              <div className="text-[11px] text-slate-400">{card.referrals_made} referred</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            <button
              disabled={busy || card.stickers_available < 10}
              onClick={() => redeem("stickers")}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white disabled:bg-slate-200 disabled:text-slate-400"
            >
              Use 10 stickers → 10% off
            </button>
            <button
              disabled={busy || card.points_available < 5}
              onClick={() => redeem("points")}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white disabled:bg-slate-200 disabled:text-slate-400"
            >
              Use 5 points → 5,000 Ks off
            </button>
          </div>

          {/* Only one discount may be given on a bill, so the cashier is told
              rather than left to work it out. */}
          <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3">
            Only one discount per bill: member card, stickers, points or a promotion.
          </p>

          <div className="mt-4 pt-3 border-t border-slate-100">
            <div className="text-sm font-medium mb-2">Record a purchase</div>
            <div className="flex flex-wrap gap-2">
              <input
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-40"
                placeholder="Bill amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <input
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-48"
                placeholder="Invoice no. (optional)"
                value={saleRef}
                onChange={(e) => setSaleRef(e.target.value)}
              />
              <button
                disabled={busy}
                onClick={recordSpend}
                className="bg-slate-900 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:bg-slate-300"
              >
                Save
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              Until the POS is in daily use, enter the bill here so the sticker is counted.
            </p>
          </div>
        </div>
      )}

      {/* Item breakdown */}
      <h3 className="font-semibold mb-2">{t("customers_itemsBought")}</h3>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-4">
        <table className="w-full text-sm min-w-[400px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_qtyColumn")}</th>
              <th className="text-left px-3 py-2">{t("barcode_totalSale")}</th>
            </tr>
          </thead>
          <tbody>
            {itemStats.map((it) => (
              <tr key={it.name} className="border-t border-slate-100">
                <td className="px-3 py-2">{it.name}</td>
                <td className="px-3 py-2">{it.qty}</td>
                <td className="px-3 py-2 font-medium">{fmt(it.spent)}</td>
              </tr>
            ))}
            {itemStats.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-slate-400 py-6">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Order history */}
      <h3 className="font-semibold mb-2">{t("customers_orderHistory")}</h3>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[650px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("admin_store")}</th>
              <th className="text-left px-3 py-2">{t("history_items")}</th>
              <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{new Date(o.created_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-500">{o.store_id}</td>
                <td className="px-3 py-2 text-slate-400 max-w-[220px] truncate">{o.items || "-"}</td>
                <td className="px-3 py-2 font-medium">{fmt(o.total)}</td>
                <td className="px-3 py-2 text-xs">{o.order_status}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-8">
                  {t("customers_noOrders")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
