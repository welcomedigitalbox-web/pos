"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase, Product, SellableItem, StockBatch, fetchSellableItems, netLineTotal } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useStore } from "../../store-context";
import { useLanguage } from "../../language-context";
import { hasPermission } from "../../permissions";
import Link from "next/link";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type LedgerRow = {
  date: string;
  type: "in" | "out" | "damage" | "transfer";
  qty: number;
  reference: string;
};

type Tab = "batches" | "ledger";

export default function ProductDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { profile } = useAuth();
  const { stores } = useStore();
  const { t } = useLanguage();

  const [product, setProduct] = useState<Product | null>(null);
  const [variantRows, setVariantRows] = useState<SellableItem[]>([]);
  const [notFound, setNotFound] = useState(false);

  const [primaryOpen, setPrimaryOpen] = useState(true);
  const [costOpen, setCostOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("batches");

  const [soldQty, setSoldQty] = useState(0);
  const [totalSale, setTotalSale] = useState(0);
  const [totalMargin, setTotalMargin] = useState(0);

  const [batches, setBatches] = useState<StockBatch[]>([]);
  const [ledgerRows, setLedgerRows] = useState<(LedgerRow & { balance: number })[]>([]);
  const [locationRows, setLocationRows] = useState<
    { storeId: string; storeName: string; isWarehouse: boolean; stockQty: number; avgCost: number }[]
  >([]);

  useEffect(() => {
    if (profile && !hasPermission(profile, "products")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);


  if (!profile || !hasPermission(profile, "products")) return null;

  async function load() {
    const { data: prod } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
    if (!prod) {
      setNotFound(true);
      return;
    }
    setProduct(prod as Product);

    // All sellable units belonging to this product (one row if it has no variants)
    // Stock now comes from every location, so the page can show a full picture
    const { data: invRows } = await supabase
      .from("store_inventory")
      .select("store_id, variant_id, stock_qty, avg_cost")
      .eq("product_id", id);

    const byLocation = new Map<string, { qty: number; value: number; name: string; wh: boolean }>();
    for (const r of (invRows as any[]) || []) {
      // store_id is plain text with no FK, so names come from context, not a join
      const loc = stores.find((st) => st.id === r.store_id);
      const cur = byLocation.get(r.store_id) || {
        qty: 0, value: 0, name: loc?.name || r.store_id, wh: !!loc?.is_warehouse,
      };
      cur.qty += Number(r.stock_qty);
      cur.value += Number(r.stock_qty) * Number(r.avg_cost);
      byLocation.set(r.store_id, cur);
    }
    setLocationRows(
      Array.from(byLocation.entries())
        .map(([sid, v]) => ({
          storeId: sid,
          storeName: v.name,
          isWarehouse: v.wh,
          stockQty: v.qty,
          avgCost: v.qty > 0 ? v.value / v.qty : 0,
        }))
        .sort((a, b) => Number(b.isWarehouse) - Number(a.isWarehouse) || b.stockQty - a.stockQty)
    );

    // Variant rows aggregated across locations
    const variantAgg = new Map<string, { qty: number; value: number }>();
    for (const r of (invRows as any[]) || []) {
      const k = r.variant_id || "base";
      const cur = variantAgg.get(k) || { qty: 0, value: 0 };
      cur.qty += Number(r.stock_qty);
      cur.value += Number(r.stock_qty) * Number(r.avg_cost);
      variantAgg.set(k, cur);
    }

    const allItems = await fetchSellableItems(stores[0]?.id || "", true);
    setVariantRows(
      allItems
        .filter((i) => i.product_id === id)
        .map((i) => {
          const a = variantAgg.get(i.variant_id || "base") || { qty: 0, value: 0 };
          return { ...i, stock_qty: a.qty, avg_cost: a.qty > 0 ? a.value / a.qty : 0 };
        })
    );

    const { data: items } = await supabase
      .from("sale_items")
      .select("qty, line_total, line_cogs, sales!inner(store_id, subtotal, discount_amount)")
      .eq("product_id", id)
      ;
    const { data: returnRows } = await supabase
      .from("sale_return_items")
      .select("qty, unit_price, unit_cogs, sale_returns!inner(store_id, status)")
      .eq("product_id", id)
      .eq("sale_returns.status", "approved");

    const returned = ((returnRows as any[]) || []).reduce(
      (acc, r) => ({
        qty: acc.qty + Number(r.qty),
        value: acc.value + Number(r.qty) * Number(r.unit_price),
        cogs: acc.cogs + Number(r.qty) * Number(r.unit_cogs),
      }),
      { qty: 0, value: 0, cogs: 0 }
    );

    const rows = (items as any[]) || [];
    const sold = rows.reduce((s, i) => s + Number(i.qty), 0) - returned.qty;
    const sale = rows.reduce(
      (s, i) => s + netLineTotal(i.line_total, i.sales?.subtotal, i.sales?.discount_amount), 0) - returned.value;
    const margin = rows.reduce(
      (s, i) => s + netLineTotal(i.line_total, i.sales?.subtotal, i.sales?.discount_amount) - Number(i.line_cogs), 0)
      - (returned.value - returned.cogs);
    setSoldQty(sold);
    setTotalSale(sale);
    setTotalMargin(margin);

    const { data: batchData } = await supabase
      .from("stock_purchases")
      .select("*")
      .eq("product_id", id)
      .gt("remaining_qty", 0)
      .order("expiry_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    setBatches(batchData || []);

    // Combined ledger: stock-in (IN), sales (OUT), damages (OUT) — scoped to this store
    const { data: purchases } = await supabase
      .from("stock_purchases")
      .select("qty, created_at, supplier")
      .eq("product_id", id)
      .order("created_at", { ascending: true });

    const { data: saleItemRows } = await supabase
      .from("sale_items")
      .select("qty, created_at, sale_id, sales!inner(store_id)")
      .eq("product_id", id)
      .order("created_at", { ascending: true });

    const { data: damageRows } = await supabase
      .from("stock_damages")
      .select("qty, created_at, reason")
      .eq("product_id", id)
      .order("created_at", { ascending: true });

    const { data: transferRows } = await supabase
      .from("stock_transfers")
      .select("qty, received_qty, created_at, from_store_id, to_store_id, status")
      .eq("product_id", id)
      .order("created_at", { ascending: true });

    // Across all locations a transfer is one movement, shown from → to
    const transferMoves: LedgerRow[] = ((transferRows as any[]) || [])
      // Stock only lands at the destination once the store confirms receipt
      .filter((tr) => tr.status !== "in_transit")
      .map((tr) => ({
        date: tr.created_at,
        type: "transfer" as const,
        qty: Number(tr.received_qty ?? tr.qty),
        reference: `${tr.from_store_id || "WH"} → ${tr.to_store_id}`,
      }));

    const combined: LedgerRow[] = [
      ...transferMoves,
      ...(purchases || []).map((p) => ({
        date: p.created_at,
        type: "in" as const,
        qty: Number(p.qty),
        reference: p.supplier ? `Stock-in (${p.supplier})` : "Stock-in",
      })),
      ...(saleItemRows || []).map((i) => ({
        date: i.created_at,
        type: "out" as const,
        qty: Number(i.qty),
        reference: `Sale #${i.sale_id.slice(0, 8).toUpperCase()}`,
      })),
      ...(damageRows || []).map((d) => ({
        date: d.created_at,
        type: "damage" as const,
        qty: Number(d.qty),
        reference: d.reason ? `Damage (${d.reason})` : "Damage",
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    const withBalance = combined.map((r) => {
      // A transfer only moves stock between locations, so the overall balance is unchanged
      if (r.type === "in") balance += r.qty;
      else if (r.type !== "transfer") balance -= r.qty;
      return { ...r, balance };
    });
    setLedgerRows(withBalance.reverse());
  }

  if (notFound) {
    return <div className="pt-8 text-center text-slate-400">{t("products_notFound")}</div>;
  }
  if (!product) {
    return <div className="pt-8 text-center text-slate-400">...</div>;
  }

  // Aggregate across all variants of this product (one row if it has none)
  const totalStock = variantRows.reduce((sum, r) => sum + r.stock_qty, 0);
  const stockValue = variantRows.reduce((sum, r) => sum + r.stock_qty * r.avg_cost, 0);
  const weightedAvgCost = totalStock > 0 ? stockValue / totalStock : 0;
  const lastPurchaseCost = variantRows.reduce((m, r) => Math.max(m, r.last_purchase_cost), 0);
  const prevAvgCost = variantRows[0]?.previous_avg_cost ?? 0;
  const hasVariants = variantRows.some((r) => r.variant_id);
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  return (
    <div className="pt-4">
      <Link href="/products" className="text-sm text-blue-600 mb-2 inline-block">
        ← {t("products_title")}
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <span className="text-2xl">📦</span>
        <h1 className="text-xl font-bold">{product.name}</h1>
      </div>
      <div className="text-slate-400 text-sm mb-4">{product.sku}</div>

      {/* Primary Information */}
      <div className="bg-white border border-slate-200 rounded-xl mb-3 overflow-hidden">
        <button
          onClick={() => setPrimaryOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-3 bg-slate-50 text-left font-semibold text-sm"
        >
          <span>{primaryOpen ? "▼" : "▶"}</span> {t("products_productName")}
        </button>
        {primaryOpen && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-4 py-4 text-sm">
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("products_name")}</div>
              <div className="mt-1">{product.name}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("products_sku")}</div>
              <div className="mt-1">{product.sku || "-"}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("products_price")}</div>
              <div className="mt-1">{fmt(product.price)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("productDetail_totalStock")}</div>
              <div className="mt-1 font-semibold">{totalStock.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("stockIn_currentStock")}</div>
              <div className={`mt-1 ${totalStock <= 5 ? "text-red-600 font-semibold" : ""}`}>
                {totalStock}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Cost & Inventory */}
      <div className="bg-white border border-slate-200 rounded-xl mb-3 overflow-hidden">
        <button
          onClick={() => setCostOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-3 bg-slate-50 text-left font-semibold text-sm"
        >
          <span>{costOpen ? "▼" : "▶"}</span> {t("barcode_avgCost")} / {t("barcode_lastAvgCost")}
        </button>
        {costOpen && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-4 py-4 text-sm">
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("barcode_avgCost")}</div>
              <div className="mt-1 font-semibold">{fmt(weightedAvgCost)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("barcode_lastAvgCost")}</div>
              <div className="mt-1">{fmt(lastPurchaseCost)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("products_previousAvgCost")}</div>
              <div className="mt-1">{fmt(prevAvgCost)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 uppercase">{t("warehouse_stockValue")}</div>
              <div className="mt-1 font-semibold">{fmt(stockValue)}</div>
            </div>
          </div>
        )}
      </div>

      {/* Sales summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500">{t("barcode_soldQty")}</div>
          <div className="text-lg font-bold mt-1">{soldQty}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500">{t("barcode_totalSale")}</div>
          <div className="text-lg font-bold mt-1">{fmt(totalSale)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500">{t("barcode_totalMargin")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{fmt(totalMargin)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl mb-4 overflow-x-auto">
        <div className="px-4 py-2 font-semibold text-sm border-b border-slate-100">
          {t("productDetail_byLocation")}
        </div>
        <table className="w-full text-sm min-w-[520px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("admin_store")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              <th className="text-left px-3 py-2">{t("barcode_avgCost")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_stockValue")}</th>
            </tr>
          </thead>
          <tbody>
            {locationRows.map((l) => (
              <tr key={l.storeId} className="border-t border-slate-100">
                <td className="px-3 py-2">{l.isWarehouse ? "🏭 " : ""}{l.storeName}</td>
                <td className={`px-3 py-2 font-medium ${l.stockQty <= 0 ? "text-red-600" : ""}`}>
                  {l.stockQty.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-slate-500">{fmt(l.avgCost)}</td>
                <td className="px-3 py-2">{fmt(l.stockQty * l.avgCost)}</td>
              </tr>
            ))}
            {locationRows.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-400 py-6">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {hasVariants && (
        <div className="bg-white border border-slate-200 rounded-xl mb-4 overflow-x-auto">
          <div className="px-4 py-2 font-semibold text-sm border-b border-slate-100">
            {t("nav_productVariant")}
          </div>
          <table className="w-full text-sm min-w-[420px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("productVariant_variantName")}</th>
                <th className="text-left px-3 py-2">{t("products_sku")}</th>
                <th className="text-left px-3 py-2">{t("products_price")}</th>
                <th className="text-left px-3 py-2">{t("barcode_balanceStock")}</th>
                <th className="text-left px-3 py-2">{t("barcode_avgCost")}</th>
              </tr>
            </thead>
            <tbody>
              {variantRows.map((r) => (
                <tr key={r.key} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{r.variant_name || "-"}</td>
                  <td className="px-3 py-2 text-slate-400">{r.sku || "-"}</td>
                  <td className="px-3 py-2">{fmt(r.price)}</td>
                  <td className={`px-3 py-2 ${r.stock_qty <= 5 ? "text-red-600 font-medium" : ""}`}>
                    {r.stock_qty}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{fmt(r.avg_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 mb-3 overflow-x-auto">
        {(["batches", "ledger"] as Tab[]).map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`px-3 py-2 text-sm whitespace-nowrap ${
              tab === tb ? "text-blue-600 font-semibold border-b-2 border-blue-600" : "text-slate-500"
            }`}
          >
            {tb === "batches" && t("barcode_batchTitle")}
            {tb === "ledger" && t("ledger_title")}
          </button>
        ))}
      </div>

      {tab === "batches" && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[450px]">
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
                const isSoon = b.expiry_date && !isExpired && new Date(b.expiry_date).getTime() - now < thirtyDays;
                return (
                  <tr key={b.id} className="border-t border-slate-100">
                    <td className={`px-3 py-2 ${isExpired ? "text-red-600 font-semibold" : isSoon ? "text-orange-600 font-medium" : ""}`}>
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
      )}

      {tab === "ledger" && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[500px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("ledger_date")}</th>
                <th className="text-left px-3 py-2">{t("ledger_type")}</th>
                <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                <th className="text-left px-3 py-2">{t("ledger_balance")}</th>
                <th className="text-left px-3 py-2">{t("ledger_reference")}</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(r.date).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        r.type === "in"
                          ? "bg-green-100 text-green-700"
                          : r.type === "damage"
                          ? "bg-red-100 text-red-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {r.type === "in" ? t("ledger_in") : r.type === "damage" ? t("nav_damage") : t("ledger_out")}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.type === "in" ? "+" : "-"}
                    {r.qty}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.balance}</td>
                  <td className="px-3 py-2 text-slate-400">{r.reference}</td>
                </tr>
              ))}
              {ledgerRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-8">
                    {t("ledger_empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
