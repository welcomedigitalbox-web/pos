"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { matchesSearch } from "@/lib/search";
import { supabase, describeError } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission, isManagerTier, APPROVER_ROLES } from "../permissions";
import * as XLSX from "xlsx";
import ProductDetail from "./detail";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type Row = {
  key: string;
  product_id: string;
  variant_id: string | null;
  display_name: string;
  sku: string | null;
  // The code printed on the supplier's own box. The warehouse reads it off
  // the carton, so it is typed here rather than back at a desk.
  supplierCode: string | null;
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
  // Which supplier code is being typed, and what went wrong if it was refused.
  const [editing, setEditing] = useState<string | null>(null);
  const [codeMsg, setCodeMsg] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  // The main location is the one being worked on; these are the others whose
  // quantities are added into the balance.
  const [alsoIds, setAlsoIds] = useState<string[]>([]);
  const [perLoc, setPerLoc] = useState<Record<string, Record<string, number>>>({});

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
  }, [locId, alsoIds]);

  // Hooks must run on every render, so the guard is applied just before the JSX.
  const pageBlocked = !profile || !hasPermission(profile, "inventory");

  async function load() {
    setLoading(true);
    const ids = [locId, ...alsoIds.filter((id) => id !== locId)];
    const pulls = await Promise.all(
      ids.map((id) => supabase.rpc("inventory_rows_json", { p_store: id }))
    );
    if (pulls[0].error) { setRows([]); setLoading(false); return; }

    // One line per product, with each place's own quantity kept beside the
    // total - a balance of 40 means nothing if 39 of them are in Mandalay.
    const merged = new Map<string, Row>();
    const split: Record<string, Record<string, number>> = {};
    ids.forEach((id, i) => {
      for (const r of ((pulls[i].data as any[]) || [])) {
        const key = `${r.product_id}:${r.variant_id || "base"}`;
        const qty = Number(r.stock_qty || 0);
        const cost = Number(r.avg_cost || 0);
        const row = merged.get(key);
        if (row) {
          row.stock_qty += qty;
          row.soldQty += Number(r.sold_qty || 0);
          row.salesValue += Number(r.sold_value || 0);
          row.stockValue += qty * cost;
          row.batchCount += Number(r.batch_count || 0);
          // The soonest expiry anywhere is the one worth acting on.
          const e = (r.nearest_expiry as string | null) ?? null;
          if (e && (!row.nearestExpiry || e < row.nearestExpiry)) row.nearestExpiry = e;
        } else {
          merged.set(key, {
            key,
            product_id: r.product_id,
            variant_id: r.variant_id,
            display_name: r.display_name,
            sku: r.sku,
            supplierCode: null,
            price: Number(r.price || 0),
            stock_qty: qty,
            avg_cost: cost,
            batches: [],
            nearestExpiry: (r.nearest_expiry as string | null) ?? null,
            batchCount: Number(r.batch_count || 0),
            stockValue: qty * cost,
            soldQty: Number(r.sold_qty || 0),
            salesValue: Number(r.sold_value || 0),
          });
        }
        split[key] = { ...(split[key] || {}), [id]: qty };
      }
    });
    setPerLoc(split);
    setRows([...merged.values()]);
    setLoading(false);

    // Supplier codes come from the product, not the stock row, so they are
    // fetched alongside and filled in once they arrive.
    // A supplier code is a barcode of kind 'supplier' - one product may
    // answer to several - so it is read from there, not from the product row.
    const byId: Record<string, string> = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("product_barcodes")
        .select("product_id,barcode")
        .eq("kind", "supplier")
        .eq("is_active", true)
        .range(from, from + 999);
      const page = (data as { product_id: string; barcode: string }[]) || [];
      for (const b of page) if (!byId[b.product_id]) byId[b.product_id] = b.barcode;
      if (error || page.length < 1000) break;
    }
    setRows((rs) => rs.map((r) => ({ ...r, supplierCode: byId[r.product_id] ?? null })));
  }

  // Typed in the warehouse, saved through the one function that also teaches
  // the tills the code. Nobody here may write to products directly.
  async function saveSupplierCode(row: Row, raw: string) {
    const code = raw.trim();
    if (!code || code === (row.supplierCode || "")) { setEditing(null); return; }
    const { error } = await supabase.rpc("set_supplier_code", {
      p_product: row.product_id,
      p_code: code,
      p_variant: row.variant_id,
    });
    if (error) { setCodeMsg(describeError(error)); return; }
    setRows((rs) => rs.map((r) =>
      r.product_id === row.product_id ? { ...r, supplierCode: code } : r));
    setEditing(null);
    setCodeMsg("");
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
      if (!matchesSearch(q, r.display_name, r.sku, r.supplierCode))
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
  // Only worth a column per place once there is more than one place.
  const shownLocs = alsoIds.length ? [locId, ...alsoIds] : [];
  const title = shownLocs.length
    ? shownLocs.map((id) => stores.find((s) => s.id === id)?.name || id).join(" + ")
    : locName;

  if (pageBlocked) return null;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_inventory")}</h2>
      <p className="text-sm text-slate-500 mb-4">{title} · {t("inventory_subtitle")}</p>

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

        {!isStoreLocked && locId && stores.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {stores.filter((s) => s.id !== locId).map((s) => {
              const on = alsoIds.includes(s.id);
              return (
                <button key={s.id} type="button"
                  onClick={() => setAlsoIds(on ? alsoIds.filter((x) => x !== s.id) : [...alsoIds, s.id])}
                  className={`px-2.5 py-1.5 rounded-lg text-xs ${
                    on ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                  {on ? "✓ " : "+ "}{s.name}
                </button>
              );
            })}
            {alsoIds.length > 0 && (
              <button type="button" onClick={() => setAlsoIds([])}
                className="px-2 py-1.5 text-xs text-slate-500 underline">
                only {locName}
              </button>
            )}
          </div>
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

      {detail && (
        <ProductDetail row={detail} storeId={locId} canSeeCost={canSeeCost}
          onClose={() => setDetail(null)} />
      )}

      {locId && <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        {codeMsg && (
          <div className="px-3 py-2 text-sm text-red-600">❌ {codeMsg}</div>
        )}
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">Supplier code</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              {shownLocs.map((id) => (
                <th key={id} className="text-left px-3 py-2 font-normal text-xs">
                  {stores.find((s) => s.id === id)?.name || id}
                </th>
              ))}
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
                    <td className="px-3 py-2">
                      <button onClick={() => setDetail(r)}
                        className="text-left hover:text-blue-600 hover:underline">
                        {r.display_name}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{r.sku || "-"}</td>
                    <td className="px-3 py-2 text-xs">
                      {editing === r.key ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            defaultValue={r.supplierCode || ""}
                            onChange={(e) => setCodeDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveSupplierCode(r, codeDraft);
                              if (e.key === "Escape") setEditing(null);
                            }}
                            className="w-32 border border-slate-300 rounded px-2 py-1 text-xs"
                          />
                          <button
                            onClick={() => saveSupplierCode(r, codeDraft)}
                            className="px-2 py-1 bg-slate-900 text-white rounded text-xs"
                          >
                            Save
                          </button>
                          <button onClick={() => setEditing(null)}
                            className="px-1 text-slate-400 text-xs">✕</button>
                        </span>
                      ) : (
                        <button
                          onClick={() => { setCodeMsg(""); setCodeDraft(r.supplierCode || ""); setEditing(r.key); }}
                          className={r.supplierCode ? "text-slate-600" : "text-slate-300 hover:text-blue-600"}
                        >
                          {r.supplierCode || "+ add"}
                        </button>
                      )}
                    </td>
                    <td className={`px-3 py-2 font-medium ${r.stock_qty <= 0 ? "text-red-600" : r.stock_qty <= 5 ? "text-orange-600" : ""}`}>
                      {r.stock_qty.toLocaleString()}
                    </td>
                    {shownLocs.map((id) => (
                      <td key={id} className="px-3 py-2 text-slate-500 text-xs">
                        {(perLoc[r.key]?.[id] || 0).toLocaleString()}
                      </td>
                    ))}
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
