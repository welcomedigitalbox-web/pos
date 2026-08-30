"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, SellableItem, fetchSellableItems, netLineTotal } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission, isManagerTier, APPROVER_ROLES } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type Row = SellableItem & {
  batches: { expiry: string | null; qty: number }[];
  stockValue: number;
  soldQty: number;
  salesValue: number;
};

export default function InventoryPage() {
  const { storeId, stores, isStoreLocked } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  // Stock value exposes cost, which shop-floor staff shouldn't see
  const canSeeCost =
    isManagerTier(profile?.role) ||
    profile?.role === "owner" || profile?.role === "admin";

  const [locId, setLocId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (profile && !hasPermission(profile, "inventory")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!locId && storeId) setLocId(storeId);
  }, [storeId, locId]);

  useEffect(() => {
    if (locId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locId]);

  if (!profile || !hasPermission(profile, "inventory")) return null;

  async function load() {
    setLoading(true);
    const items = await fetchSellableItems(locId);

    const { data: batchRows } = await supabase
      .from("stock_purchases")
      .select("product_id, variant_id, expiry_date, remaining_qty")
      .eq("store_id", locId)
      .gt("remaining_qty", 0)
      .order("expiry_date", { ascending: true, nullsFirst: false });

    const key = (p: string, v: string | null) => `${p}:${v || "base"}`;
    const batchMap = new Map<string, { expiry: string | null; qty: number }[]>();
    for (const b of (batchRows as any[]) || []) {
      const k = key(b.product_id, b.variant_id);
      const list = batchMap.get(k) || [];
      const hit = list.find((e) => e.expiry === b.expiry_date);
      if (hit) hit.qty += Number(b.remaining_qty);
      else list.push({ expiry: b.expiry_date, qty: Number(b.remaining_qty) });
      batchMap.set(k, list);
    }

    // "What's on the shelf" only half answers the question — staff also want to
    // know how much has gone out of this store.
    const { data: saleRows } = await supabase
      .from("sale_items")
      .select("product_id, variant_id, qty, line_total, sales!inner(store_id, subtotal, discount_amount)")
      .eq("sales.store_id", locId);

    const soldMap = new Map<string, { qty: number; value: number }>();
    for (const r of (saleRows as any[]) || []) {
      const k = key(r.product_id, r.variant_id);
      const cur = soldMap.get(k) || { qty: 0, value: 0 };
      cur.qty += Number(r.qty);
      cur.value += netLineTotal(r.line_total, r.sales?.subtotal, r.sales?.discount_amount);
      soldMap.set(k, cur);
    }

    // Approved returns came back, so they are not sales
    const { data: returnRows } = await supabase
      .from("sale_return_items")
      .select("product_id, variant_id, qty, unit_price, sale_returns!inner(store_id, status)")
      .eq("sale_returns.status", "approved")
      .eq("sale_returns.store_id", locId);

    for (const r of (returnRows as any[]) || []) {
      const k = key(r.product_id, r.variant_id);
      const cur = soldMap.get(k) || { qty: 0, value: 0 };
      cur.qty -= Number(r.qty);
      cur.value -= Number(r.qty) * Number(r.unit_price);
      soldMap.set(k, cur);
    }

    setRows(
      items.map((i) => {
        const sold = soldMap.get(key(i.product_id, i.variant_id)) || { qty: 0, value: 0 };
        return {
          ...i,
          batches: batchMap.get(key(i.product_id, i.variant_id)) || [],
          stockValue: i.stock_qty * i.avg_cost,
          soldQty: sold.qty,
          salesValue: sold.value,
        };
      })
    );
    setLoading(false);
  }

  const now = Date.now();
  const thirtyDays = 30 * 86400000;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "in_stock" && r.stock_qty <= 0) return false;
      if (statusFilter === "out_of_stock" && r.stock_qty > 0) return false;
      if (statusFilter === "low" && !(r.stock_qty > 0 && r.stock_qty <= 5)) return false;
      if (statusFilter === "expiring") {
        const soon = r.batches.some(
          (b) => b.expiry && new Date(b.expiry).getTime() - now < thirtyDays && new Date(b.expiry).getTime() >= now
        );
        if (!soon) return false;
      }
      if (statusFilter === "expired") {
        const bad = r.batches.some((b) => b.expiry && new Date(b.expiry).getTime() < now);
        if (!bad) return false;
      }
      if (q && !r.display_name.toLowerCase().includes(q) && !(r.sku || "").toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [rows, search, statusFilter, now, thirtyDays]);

  const totals = useMemo(
    () => ({
      products: filtered.length,
      qty: filtered.reduce((s, r) => s + r.stock_qty, 0),
      sold: filtered.reduce((s, r) => s + r.soldQty, 0),
      salesValue: filtered.reduce((s, r) => s + r.salesValue, 0),
      value: filtered.reduce((s, r) => s + r.stockValue, 0),
      outOfStock: filtered.filter((r) => r.stock_qty <= 0).length,
    }),
    [filtered]
  );

  const locName = stores.find((s) => s.id === locId)?.name || locId;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_inventory")}</h2>
      <p className="text-sm text-slate-500 mb-4">{locName} · {t("inventory_subtitle")}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {!isStoreLocked && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={locId} onChange={(e) => setLocId(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.is_warehouse ? `🏭 ${s.name}` : s.name}</option>
            ))}
          </select>
        )}

        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">{t("warehouse_allStock")}</option>
          <option value="in_stock">{t("warehouse_inStock")}</option>
          <option value="low">{t("inventory_lowStock")}</option>
          <option value="out_of_stock">{t("warehouse_outOfStock")}</option>
          <option value="expiring">{t("warehouse_expiringSoon")}</option>
          <option value="expired">{t("warehouse_expired")}</option>
        </select>

        <input className="flex-1 min-w-[200px] border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder={t("warehouse_searchPlaceholder")}
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_products")}</div>
          <div className="text-xl font-bold mt-1">{totals.products}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_availableQty")}</div>
          <div className="text-xl font-bold mt-1">{totals.qty.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("ledger_unitsSold")}</div>
          <div className="text-xl font-bold mt-1">{totals.sold.toLocaleString()}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("barcode_totalSale")}</div>
          <div className="text-lg font-bold mt-1">{fmt(totals.salesValue)}</div>
        </div>
        {canSeeCost && (
          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-xs text-slate-500 uppercase">{t("warehouse_stockValue")}</div>
            <div className="text-lg font-bold mt-1">{fmt(totals.value)}</div>
          </div>
        )}
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("warehouse_outOfStock")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{totals.outOfStock}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              <th className="text-left px-3 py-2">{t("ledger_unitsSold")}</th>
              <th className="text-left px-3 py-2">{t("products_price")}</th>
              {canSeeCost && <th className="text-left px-3 py-2">{t("warehouse_stockValue")}</th>}
              <th className="text-left px-3 py-2">{t("warehouse_colExpiry")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filtered.map((r) => {
              const nearest = r.batches[0]?.expiry || null;
              const expired = nearest ? new Date(nearest).getTime() < now : false;
              const soon = nearest && !expired ? new Date(nearest).getTime() - now < thirtyDays : false;
              return (
                <>
                  <tr key={r.key} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.display_name}</td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{r.sku || "-"}</td>
                    <td className={`px-3 py-2 font-medium ${r.stock_qty <= 0 ? "text-red-600" : r.stock_qty <= 5 ? "text-orange-600" : ""}`}>
                      {r.stock_qty.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{r.soldQty.toLocaleString()}</td>
                    <td className="px-3 py-2">{fmt(r.price)}</td>
                    {canSeeCost && (
                      <td className="px-3 py-2 text-slate-500">{fmt(r.stockValue)}</td>
                    )}
                    <td className={`px-3 py-2 text-xs ${expired ? "text-red-600 font-semibold" : soon ? "text-orange-600 font-medium" : "text-slate-400"}`}>
                      {nearest || "-"}
                      {expired && " ⚠️"}
                      {soon && " ⏰"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.batches.length > 1 && (
                        <button onClick={() => setExpanded(expanded === r.key ? null : r.key)}
                          className="text-blue-600 text-xs font-medium">
                          {expanded === r.key ? t("ledger_hideMovement") : t("ledger_expiryBatches")}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === r.key && (
                    <tr key={`${r.key}-exp`} className="bg-amber-50/40">
                      <td colSpan={8} className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          {r.batches.map((b, bi) => {
                            const bExpired = b.expiry ? new Date(b.expiry).getTime() < now : false;
                            const bSoon = b.expiry && !bExpired ? new Date(b.expiry).getTime() - now < thirtyDays : false;
                            return (
                              <span key={bi} className={`text-xs px-2 py-1 rounded border ${
                                bExpired ? "border-red-200 bg-red-50 text-red-700"
                                : bSoon ? "border-orange-200 bg-orange-50 text-orange-700"
                                : "border-slate-200 bg-white text-slate-600"}`}>
                                {b.expiry || t("ledger_noExpiry")} · <strong>{b.qty.toLocaleString()}</strong>
                                {bExpired && " ⚠️"}
                                {bSoon && " ⏰"}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">{t("warehouse_empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
