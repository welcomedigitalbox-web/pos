"use client";

import { useEffect, useState } from "react";
import { supabase, SellableItem, StockBatch, fetchSellableItems, netLineTotal } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function BarcodePage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [code, setCode] = useState("");
  const [product, setProduct] = useState<SellableItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [soldQty, setSoldQty] = useState(0);
  const [totalSale, setTotalSale] = useState(0);
  const [totalMargin, setTotalMargin] = useState(0);
  const [batches, setBatches] = useState<StockBatch[]>([]);
  const [storeBreakdown, setStoreBreakdown] = useState<
    { storeId: string; storeName: string; isWarehouse: boolean; stockQty: number; avgCost: number;
      batches: { expiry: string | null; qty: number }[] }[]
  >([]);
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null);

  useEffect(() => {
    if (profile && !hasPermission(profile, "barcode")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (!profile || !hasPermission(profile, "barcode")) return null;

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const query = code.trim();
    if (!query) return;

    // Search across every sellable unit (variant SKUs included), not just parent SKUs
    const allItems = await fetchSellableItems(storeId, true);
    const prod =
      allItems.find((i) => (i.sku || "").toLowerCase() === query.toLowerCase()) || null;

    if (!prod) {
      setProduct(null);
      setNotFound(true);
      return;
    }
    setNotFound(false);
    setProduct(prod);

    let saleQuery = supabase
      .from("sale_items")
      .select("qty, line_total, line_cogs, sales!inner(subtotal, discount_amount)")
      .eq("product_id", prod.product_id);
    saleQuery = prod.variant_id
      ? saleQuery.eq("variant_id", prod.variant_id)
      : saleQuery.is("variant_id", null);
    const { data: items } = await saleQuery;

    const sold = (items || []).reduce((sum, i) => sum + Number(i.qty), 0);
    const rows = (items as any[]) || [];
    const sale = rows.reduce(
      (sum, i) => sum + netLineTotal(i.line_total, i.sales?.subtotal, i.sales?.discount_amount), 0);
    const margin = rows.reduce(
      (sum, i) => sum + netLineTotal(i.line_total, i.sales?.subtotal, i.sales?.discount_amount) - Number(i.line_cogs), 0);
    setSoldQty(sold);
    setTotalSale(sale);
    setTotalMargin(margin);

    let batchQuery = supabase
      .from("stock_purchases")
      .select("*")
      .eq("product_id", prod.product_id)
      .eq("store_id", storeId)
      .gt("remaining_qty", 0);
    batchQuery = prod.variant_id
      ? batchQuery.eq("variant_id", prod.variant_id)
      : batchQuery.is("variant_id", null);
    const { data: batchData } = await batchQuery
      .order("expiry_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    setBatches(batchData || []);

    // Stock breakdown across ALL stores (not just the current one)
    let invQuery = supabase
      .from("store_inventory")
      .select("store_id, stock_qty, avg_cost, stores(name, is_warehouse)")
      .eq("product_id", prod.product_id);
    invQuery = prod.variant_id
      ? invQuery.eq("variant_id", prod.variant_id)
      : invQuery.is("variant_id", null);
    const { data: inventoryRows } = await invQuery;
    // Remaining batches per location, so one barcode with several expiry dates
    // can be drilled into rather than shown as a single lump
    let batchAllQuery = supabase
      .from("stock_purchases")
      .select("store_id, expiry_date, remaining_qty")
      .eq("product_id", prod.product_id)
      .gt("remaining_qty", 0);
    batchAllQuery = prod.variant_id
      ? batchAllQuery.eq("variant_id", prod.variant_id)
      : batchAllQuery.is("variant_id", null);
    const { data: allBatches } = await batchAllQuery.order("expiry_date", {
      ascending: true,
      nullsFirst: false,
    });

    const batchByStore = new Map<string, { expiry: string | null; qty: number }[]>();
    for (const b of (allBatches as any[]) || []) {
      const list = batchByStore.get(b.store_id) || [];
      const hit = list.find((e) => e.expiry === b.expiry_date);
      if (hit) hit.qty += Number(b.remaining_qty);
      else list.push({ expiry: b.expiry_date, qty: Number(b.remaining_qty) });
      batchByStore.set(b.store_id, list);
    }

    const breakdown = ((inventoryRows as any[]) || [])
      .map((row) => ({
        storeId: row.store_id,
        storeName: row.stores?.name || row.store_id,
        isWarehouse: !!row.stores?.is_warehouse,
        stockQty: Number(row.stock_qty),
        avgCost: Number(row.avg_cost),
        batches: batchByStore.get(row.store_id) || [],
      }))
      // Warehouses first, then by how much is on hand
      .sort((a, b) => Number(b.isWarehouse) - Number(a.isWarehouse) || b.stockQty - a.stockQty);
    setStoreBreakdown(breakdown);
  }

  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-3">{t("barcode_title")}</h2>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          autoFocus
          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder={t("barcode_placeholder")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
          🔍
        </button>
      </form>

      {notFound && (
        <div className="text-center text-red-500 text-sm py-6 bg-white border border-slate-200 rounded-xl">
          {t("barcode_notFound")}
        </div>
      )}

      {product && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="font-semibold text-lg">{product.display_name}</div>
            <div className="text-slate-400 text-sm mb-3">{product.sku}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-slate-500">{t("barcode_balanceStock")}</div>
                <div className="font-bold">{product.stock_qty}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{t("barcode_soldQty")}</div>
                <div className="font-bold">{soldQty}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{t("barcode_avgCost")}</div>
                <div className="font-bold">{fmt(product.avg_cost)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{t("barcode_lastAvgCost")}</div>
                <div className="font-bold">{fmt(product.last_purchase_cost)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{t("barcode_totalSale")}</div>
                <div className="font-bold">{fmt(totalSale)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">{t("barcode_totalMargin")}</div>
                <div className="font-bold text-green-700">{fmt(totalMargin)}</div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <div className="px-4 py-2 font-semibold text-sm border-b border-slate-100">
              {t("barcode_storeBreakdownTitle")}
            </div>
            <table className="w-full text-sm min-w-[350px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("admin_store")}</th>
                  <th className="text-left px-3 py-2">{t("barcode_balanceStock")}</th>
                  <th className="text-left px-3 py-2">{t("products_price")}</th>
                  <th className="text-left px-3 py-2">{t("barcode_avgCost")}</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {storeBreakdown.map((row) => (
                  <>
                    <tr key={row.storeId} className={`border-t border-slate-100 ${row.storeId === storeId ? "bg-blue-50" : ""}`}>
                      <td className="px-3 py-2">
                        {row.isWarehouse ? "🏭 " : ""}
                        {row.storeName}
                        {row.storeId === storeId && (
                          <span className="ml-1 text-xs text-blue-600">({t("barcode_currentStore")})</span>
                        )}
                      </td>
                      <td className={`px-3 py-2 font-medium ${row.stockQty <= 5 ? "text-red-600" : ""}`}>
                        {row.stockQty}
                      </td>
                      <td className="px-3 py-2">{fmt(product.price)}</td>
                      <td className="px-3 py-2 text-slate-500">{fmt(row.avgCost)}</td>
                      <td className="px-3 py-2 text-right">
                        {row.batches.length > 1 && (
                          <button
                            onClick={() => setExpandedLoc(expandedLoc === row.storeId ? null : row.storeId)}
                            className="text-blue-600 text-xs font-medium"
                          >
                            {expandedLoc === row.storeId ? t("ledger_hideMovement") : t("ledger_expiryBatches")}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedLoc === row.storeId && (
                      <tr key={`${row.storeId}-exp`} className="bg-amber-50/40">
                        <td colSpan={5} className="px-3 py-2">
                          <div className="flex flex-wrap gap-2">
                            {row.batches.map((b, bi) => {
                              const expired = b.expiry ? new Date(b.expiry).getTime() < Date.now() : false;
                              const soon =
                                b.expiry && !expired
                                  ? new Date(b.expiry).getTime() - Date.now() < 30 * 86400000
                                  : false;
                              return (
                                <span key={bi} className={`text-xs px-2 py-1 rounded border ${
                                  expired ? "border-red-200 bg-red-50 text-red-700"
                                  : soon ? "border-orange-200 bg-orange-50 text-orange-700"
                                  : "border-slate-200 bg-white text-slate-600"}`}>
                                  {b.expiry || t("ledger_noExpiry")} · <strong>{b.qty.toLocaleString()}</strong>
                                  {expired && " ⚠️"}
                                  {soon && " ⏰"}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
                {storeBreakdown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-400 py-6">
                      -
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <div className="px-4 py-2 font-semibold text-sm border-b border-slate-100">
              {t("barcode_batchTitle")}
            </div>
            <table className="w-full text-sm min-w-[400px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("barcode_batchExpiry")}</th>
                  <th className="text-left px-3 py-2">{t("barcode_batchQty")}</th>
                  <th className="text-left px-3 py-2">{t("barcode_batchCost")}</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const isExpired = b.expiry_date && new Date(b.expiry_date).getTime() < now;
                  const isSoon =
                    b.expiry_date && !isExpired && new Date(b.expiry_date).getTime() - now < thirtyDays;
                  return (
                    <tr key={b.id} className="border-t border-slate-100">
                      <td
                        className={`px-3 py-2 ${
                          isExpired ? "text-red-600 font-semibold" : isSoon ? "text-orange-600 font-medium" : ""
                        }`}
                      >
                        {b.expiry_date || "-"}
                      </td>
                      <td className="px-3 py-2">{b.remaining_qty}</td>
                      <td className="px-3 py-2">{fmt(b.unit_cost)}</td>
                      <td className="px-3 py-2 text-xs">
                        {isExpired && <span className="text-red-600">⚠️ {t("barcode_expired")}</span>}
                        {isSoon && <span className="text-orange-600">⏰ {t("barcode_expiringSoon")}</span>}
                      </td>
                    </tr>
                  );
                })}
                {batches.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-slate-400 py-6">
                      {t("barcode_noBatch")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
