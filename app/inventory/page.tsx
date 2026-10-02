"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase, SellableItem, fetchSellableItems, netLineTotal, describeError } from "@/lib/supabase";
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
  // Correcting a cost used to be a tick box on a purchase order, where it
  // was reached by accident. It lives here instead: the head of
  // merchandising only, a reason required, and the whole change logged.
  const [canCorrectCost, setCanCorrectCost] = useState(false);
  const [fixRow, setFixRow] = useState<Row | null>(null);
  const [fixCost, setFixCost] = useState("");
  const [fixReason, setFixReason] = useState("");
  const [fixing, setFixing] = useState(false);
  const [toast, setToast] = useState("");

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 4000);
  }

  function openFix(r: Row) {
    setFixRow(r);
    setFixCost(String(r.avg_cost || ""));
    setFixReason("");
  }

  async function submitFix() {
    if (!fixRow) return;
    setFixing(true);
    try {
      const { data, error } = await supabase.rpc("correct_avg_cost", {
        p_product: fixRow.product_id,
        p_variant: fixRow.variant_id,
        p_store: locId,
        p_new_cost: Number(fixCost),
        p_reason: fixReason,
      });
      if (error) throw error;
      const d = (data as any[])?.[0];
      showToast(
        d
          ? `\u2705 ${fmt(d.old_cost)} \u2192 ${fmt(d.new_cost)} (${t("warehouse_stockValue")} ${
              d.value_change >= 0 ? "+" : ""
            }${fmt(d.value_change)})`
          : "\u2705"
      );
      setFixRow(null);
      await load();
    } catch (err) {
      showToast("\u274c " + describeError(err));
    } finally {
      setFixing(false);
    }
  }

  useEffect(() => {
    if (profile && !hasPermission(profile, "inventory")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!locId && storeId) setLocId(storeId);
  }, [storeId, locId]);

  // Asked of the server, which is also the only place the answer matters:
  // correct_avg_cost refuses anyone else whatever the browser believes.
  useEffect(() => {
    if (!profile) return;
    let live = true;
    supabase
      .rpc("can_approve_dept", { p_department: "merchandising" })
      .then(({ data }) => { if (live) setCanCorrectCost(!!data); });
    return () => { live = false; };
  }, [profile?.id]);

  useEffect(() => {
    if (locId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locId]);

  // Hooks must run on every render, so the guard is applied just before the JSX.
  const pageBlocked = !profile || !hasPermission(profile, "inventory");

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

  if (pageBlocked) return null;

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
                    <td className="px-3 py-2 text-right space-x-2">
                      {canCorrectCost && !r.is_consignment && r.stock_qty > 0 && (
                        <button onClick={() => openFix(r)}
                          className="text-slate-500 text-xs font-medium">
                          {t("inv_fixCost")}
                        </button>
                      )}
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
                </Fragment>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">{t("warehouse_empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {fixRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("inv_fixCostTitle")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {fixRow.display_name} · {locId}
            </p>

            <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
              <div className="bg-slate-50 rounded-lg px-3 py-2">
                <div className="text-xs text-slate-500">{t("inv_fixCostNow")}</div>
                <div className="font-medium">{fmt(fixRow.avg_cost)}</div>
              </div>
              <div className="bg-slate-50 rounded-lg px-3 py-2">
                <div className="text-xs text-slate-500">{t("warehouse_colAvailable")}</div>
                <div className="font-medium">{fixRow.stock_qty.toLocaleString()}</div>
              </div>
            </div>

            <label className="text-xs text-slate-500">{t("inv_fixCostNew")}</label>
            <input type="number" value={fixCost} onChange={(e) => setFixCost(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" />

            {/* The consequence, before the button rather than after it. */}
            {Number(fixCost) >= 0 && fixCost !== "" && (
              <p className="text-xs bg-amber-50 text-amber-800 rounded-lg px-3 py-2 mb-3">
                {t("inv_fixCostImpact")}{" "}
                <strong>
                  {(Number(fixCost) - (fixRow.avg_cost || 0)) * fixRow.stock_qty >= 0 ? "+" : ""}
                  {fmt((Number(fixCost) - (fixRow.avg_cost || 0)) * fixRow.stock_qty)}
                </strong>
              </p>
            )}

            <label className="text-xs text-slate-500">{t("inv_fixCostReason")}</label>
            <textarea value={fixReason} onChange={(e) => setFixReason(e.target.value)} rows={2}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1" />
            <p className="text-xs text-slate-400 mb-4">{t("inv_fixCostHint")}</p>

            <div className="flex gap-2">
              <button onClick={() => setFixRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitFix}
                disabled={fixing || fixReason.trim().length < 10 || fixCost === ""}
                className="flex-1 py-2.5 bg-slate-800 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {fixing ? "..." : t("inv_fixCostSave")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
