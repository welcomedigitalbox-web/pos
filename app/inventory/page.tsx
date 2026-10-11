"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission, isManagerTier, APPROVER_ROLES } from "../permissions";
import * as XLSX from "xlsx";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type Row = {
  key: string;
  product_id: string;
  variant_id: string | null;
  display_name: string;
  sku: string | null;
  price: number;
  stock_qty: number;
  avg_cost: number;
  batches: { expiry: string | null; qty: number }[];
  nearestExpiry: string | null;
  batchCount: number;
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

  // Hooks must run on every render, so the guard is applied just before the JSX.
  const pageBlocked = !profile || !hasPermission(profile, "inventory");

  async function load() {
    setLoading(true);
    // The database caps one answer at a thousand rows, and the shop carries
    // nearly three thousand products.
    const all: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .rpc("inventory_rows", { p_store: locId })
        .order("display_name")
        .range(from, from + 999);
      if (error) { setRows([]); setLoading(false); return; }
      const page = (data as any[]) || [];
      all.push(...page);
      if (page.length < 1000) break;
    }
    setRows(all.map((r) => ({
      key: `${r.product_id}:${r.variant_id || "base"}`,
      product_id: r.product_id,
      variant_id: r.variant_id,
      display_name: r.display_name,
      sku: r.sku,
      price: Number(r.price || 0),
      stock_qty: Number(r.stock_qty || 0),
      avg_cost: Number(r.avg_cost || 0),
      batches: [],
      nearestExpiry: (r.nearest_expiry as string | null) ?? null,
      batchCount: Number(r.batch_count || 0),
      stockValue: Number(r.stock_qty || 0) * Number(r.avg_cost || 0),
      soldQty: Number(r.sold_qty || 0),
      salesValue: Number(r.sold_value || 0),
    })));
    setLoading(false);
  }

  async function loadBatches(row: Row) {
    if (row.batches.length) return;
    let q = supabase.from("stock_purchases")
      .select("expiry_date, remaining_qty")
      .eq("store_id", locId).eq("product_id", row.product_id)
      .gt("remaining_qty", 0)
      .order("expiry_date", { ascending: true, nullsFirst: false });
    q = row.variant_id ? q.eq("variant_id", row.variant_id) : q.is("variant_id", null);
    const { data } = await q;
    const list: { expiry: string | null; qty: number }[] = [];
    for (const b of (data as any[]) || []) {
      const hit = list.find((e) => e.expiry === b.expiry_date);
      if (hit) hit.qty += Number(b.remaining_qty);
      else list.push({ expiry: b.expiry_date, qty: Number(b.remaining_qty) });
    }
    setRows((rs) => rs.map((x) => (x.key === row.key ? { ...x, batches: list } : x)));
  }

  // Two sheets: what the page shows, and a blank count sheet shaped exactly
  // like the opening-stock importer so a shop can fill the Qty column.
  function exportExcel() {
    const view = filtered.map((r) => ({
      Product: r.display_name,
      Barcode: r.sku || "",
      Available: r.stock_qty,
      "Units Sold": r.soldQty,
      Price: r.price,
      ...(canSeeCost ? { "Stock Value": r.stockValue } : {}),
      Expiry: r.nearestExpiry || "",
    }));
    const count = filtered.map((r) => ({
      SKU: r.sku || "",
      Store: locId,
      Qty: "",
      "Unit Cost": r.avg_cost || "",
      "Expiry Date": "",
      Product: r.display_name,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(view), "Inventory");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(count), "Opening Stock");
    const day = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `inventory-${locId}-${day}.xlsx`);
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
        const e = r.nearestExpiry ? new Date(r.nearestExpiry).getTime() : null;
        if (!(e !== null && e >= now && e - now < thirtyDays)) return false;
      }
      if (statusFilter === "expired") {
        const e = r.nearestExpiry ? new Date(r.nearestExpiry).getTime() : null;
        if (!(e !== null && e < now)) return false;
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

  if (pageBlocked) return null;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_inventory")}</h2>
      <p className="text-sm text-slate-500 mb-4">{locName} · {t("inventory_subtitle")}</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {!isStoreLocked && (
          <select className={"border rounded-lg px-3 py-2 text-sm " + (locId ? "border-slate-200" : "border-blue-500 ring-2 ring-blue-100")}
            value={locId} onChange={(e) => setLocId(e.target.value)}>
            {!locId && <option value="">{t("store_choose")}</option>}
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

        <button type="button" onClick={exportExcel} disabled={loading || filtered.length === 0}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium disabled:opacity-40">
          Excel
        </button>
      </div>

      {locId && <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
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
      </div>}

      {!locId && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">
          {t("store_chooseFirst")}
        </div>
      )}

      {locId && <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
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
              const nearest = r.nearestExpiry;
              const expired = nearest ? new Date(nearest).getTime() < now : false;
              const soon = nearest && !expired ? new Date(nearest).getTime() - now < thirtyDays : false;
              return (
                <Fragment key={r.key}>
                  <tr className="border-t border-slate-100">
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
                      {r.batchCount > 1 && (
                        <button onClick={() => { const open = expanded === r.key ? null : r.key; setExpanded(open); if (open) loadBatches(r); }}
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
                </Fragment>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">{t("warehouse_empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>}
    </div>
  );
}
