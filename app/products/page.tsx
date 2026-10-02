"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, Product, SellableItem, ProductCategory, ProductVariant, fetchSellableItems, upsertStoreInventory } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type FormState = {
  id: string | null;
  name: string;
  sku: string;
  price: string;
  stock_qty: string;
  avg_cost: string;
  category_id: string;
  is_consignment: boolean;
  requires_expiry: boolean;
  allow_discount: boolean;
  allow_promotion: boolean;
  min_price: string;
};

const emptyForm: FormState = { id: null, name: "", sku: "", price: "", stock_qty: "", avg_cost: "", category_id: "", is_consignment: false, requires_expiry: false, allow_discount: true, allow_promotion: true, min_price: "" };

export default function ProductsPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const [items, setItems] = useState<SellableItem[]>([]);
  const [rawProducts, setRawProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [editingVariants, setEditingVariants] = useState<ProductVariant[]>([]);
  const [variantStock, setVariantStock] = useState<Record<string, number>>({});
  const [newVariantName, setNewVariantName] = useState("");
  const [newVariantSku, setNewVariantSku] = useState("");
  const [newVariantPrice, setNewVariantPrice] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [availRow, setAvailRow] = useState<{ id: string; name: string } | null>(null);
  const [availOff, setAvailOff] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "products")) {
      router.replace("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "products")) return null;

  async function load() {
    setLoading(true);
    try {
      // One pass: the catalog, the company-wide stock, and the cost
      // merchandising quoted for items that have never been received yet.
      const [rawRes, itemsRes, invRows, costRes] = await Promise.all([
        supabase.from("products").select("*").order("name"),
        fetchSellableItems(storeId, true),
        fetchAllInventory(),
        supabase.from("product_cost_reference").select("sku, cost"),
      ]);

      setRawProducts((rawRes.data as Product[]) || []);
      const data = itemsRes;

      const refCost = new Map<string, number>();
      for (const r of (costRes.data as { sku: string; cost: number }[]) || []) {
        refCost.set(r.sku, Number(r.cost));
      }

      const key = (pid: string, v: string | null) => `${pid}:${v || "base"}`;
      const totals = new Map<string, { qty: number; value: number }>();
      for (const r of invRows) {
        const k = key(r.product_id, r.variant_id);
        const cur = totals.get(k) || { qty: 0, value: 0 };
        cur.qty += Number(r.stock_qty);
        cur.value += Number(r.stock_qty) * Number(r.avg_cost);
        totals.set(k, cur);
      }

      const merged = data.map((i) => {
        const agg = totals.get(key(i.product_id, i.variant_id)) || { qty: 0, value: 0 };
        // With no stock anywhere there is no average to take, so fall back to
        // the quoted cost rather than showing a bare zero.
        const cost = agg.qty > 0 ? agg.value / agg.qty : refCost.get(i.sku || "") ?? 0;
        return { ...i, stock_qty: agg.qty, avg_cost: cost };
      });
      setItems(merged);
    } finally {
      setLoading(false);
    }
  }

  // Supabase caps a response at 1,000 rows, so the ledger is read in pages —
  // otherwise the stock of everything past the first page reads as zero.
  async function fetchAllInventory() {
    const page = 1000;
    const out: { product_id: string; variant_id: string | null; stock_qty: number; avg_cost: number }[] = [];
    for (let from = 0; ; from += page) {
      const { data, error } = await supabase
        .from("store_inventory")
        .select("product_id, variant_id, stock_qty, avg_cost")
        .range(from, from + page - 1);
      if (error || !data || data.length === 0) break;
      out.push(...(data as typeof out));
      if (data.length < page) break;
    }
    return out;
  }

  async function loadCategories() {
    const { data } = await supabase.from("product_categories").select("*").order("sort_order");
    setCategories(data || []);
  }

  async function loadVariants(productId: string) {
    const { data } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", productId)
      .order("created_at");
    setEditingVariants(data || []);

    // Current store's stock for each variant, so it can be shown/edited inline
    const { data: inv } = await supabase
      .from("store_inventory")
      .select("variant_id, stock_qty")
      .eq("store_id", storeId)
      .eq("product_id", productId);
    const map: Record<string, number> = {};
    for (const row of inv || []) {
      if (row.variant_id) map[row.variant_id] = Number(row.stock_qty);
    }
    setVariantStock(map);
  }

  async function updateVariantStock(variantId: string, value: string) {
    const qty = value.trim() === "" ? 0 : Number(value);
    if (isNaN(qty) || qty < 0) return showToast(t("products_stockInvalid"));
    if (!form.id) return;
    await upsertStoreInventory(storeId, form.id, variantId, { stock_qty: qty });
    showToast(t("productVariant_stockSaved"));
    await loadVariants(form.id);
    await load();
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  function generateSku() {
    // A product is shared across every location, so its barcode must be too —
    // a store prefix would give the same item a different code per shop.
    const storePrefix = "P";
    const timestampPart = Date.now().toString().slice(-6);
    const randomPart = Math.floor(Math.random() * 90 + 10); // 2-digit
    return `${storePrefix}-${timestampPart}${randomPart}`;
  }




  async function openAvailability(productId: string, name: string) {
    const { data } = await supabase
      .from("store_product_settings")
      .select("store_id, is_available")
      .eq("product_id", productId);
    // Only rows explicitly marked unavailable are stored; everything else is on
    setAvailOff(
      new Set(((data as any[]) || []).filter((r) => !r.is_available).map((r) => r.store_id))
    );
    setAvailRow({ id: productId, name });
  }

  async function toggleAvailability(storeIdToToggle: string) {
    if (!availRow) return;
    const turningOff = !availOff.has(storeIdToToggle);

    const { error } = await supabase.from("store_product_settings").upsert(
      {
        store_id: storeIdToToggle,
        product_id: availRow.id,
        is_available: !turningOff,
        updated_by: profile?.email || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,product_id" }
    );
    if (error) return showToast("❌ " + error.message);

    const next = new Set(availOff);
    if (turningOff) next.add(storeIdToToggle);
    else next.delete(storeIdToToggle);
    setAvailOff(next);
  }

  async function handleDelete(id: string) {
    if (!confirm(t("products_deleteConfirm"))) return;

    // Variants and empty stock rows belong to the product, not to its history —
    // clearing them first stops a plain delete being mistaken for "has sales"
    await supabase.from("product_variants").delete().eq("product_id", id);
    await supabase.from("store_inventory").delete().eq("product_id", id).eq("stock_qty", 0);

    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) {
      if (error.message.includes("foreign key") || error.message.includes("violates")) {
        // This product has sale history — offer to archive instead of a hard delete
        if (confirm(t("products_hasSalesArchiveConfirm"))) {
          await supabase.from("products").update({ is_active: false }).eq("id", id);
          showToast(t("products_archived"));
          await load();
        }
        return;
      }
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("products_deleteSuccess"));
    await load();
  }

  function generateVariantSku(variantName: string) {
    // Derive from the parent SKU so variants stay visually grouped, e.g. SKU-001-L
    const base = form.sku.trim() || generateSku();
    const suffix = variantName.trim().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase();
    return suffix ? `${base}-${suffix}` : base;
  }

  async function addVariant() {
    if (!form.id || !newVariantName.trim()) return;
    const { error } = await supabase.from("product_variants").insert({
      product_id: form.id,
      variant_name: newVariantName.trim(),
      sku: newVariantSku.trim() || generateVariantSku(newVariantName),
      price_override: newVariantPrice ? Number(newVariantPrice) : null,
    });
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    setNewVariantName("");
    setNewVariantSku("");
    setNewVariantPrice("");
    await loadVariants(form.id);
  }

  async function updateVariantPrice(id: string, value: string) {
    const price = value.trim() === "" ? null : Number(value);
    if (price !== null && (isNaN(price) || price < 0)) return showToast(t("products_priceInvalid"));
    const { error } = await supabase
      .from("product_variants")
      .update({ price_override: price })
      .eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("productVariant_priceSaved"));
    if (form.id) await loadVariants(form.id);
    await load();
  }

  async function deleteVariant(id: string) {
    await supabase.from("product_variants").delete().eq("id", id);
    if (form.id) await loadVariants(form.id);
  }

  async function handleToggleActive(productId: string) {
    const parent = rawProducts.find((p) => p.id === productId);
    if (!parent) return;
    await supabase.from("products").update({ is_active: !parent.is_active }).eq("id", productId);
    showToast(parent.is_active ? t("products_archived") : t("products_restored"));
    await load();
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("products_title")}</h2>
        <Link
          href="/products/new"
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
        >
          {t("products_addNew")}
        </Link>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("products_name")}</th>
              <th className="text-left px-4 py-2">{t("products_sku")}</th>
              <th className="text-left px-4 py-2">{t("products_price")}</th>
              <th className="text-left px-4 py-2">{t("products_avgCost")}</th>
              <th className="text-left px-4 py-2">{t("productDetail_totalStock")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.key} className={`border-t border-slate-100 ${!row.is_active ? "opacity-50 bg-slate-50" : ""}`}>
                <td className="px-4 py-2">
                  {row.product_name}
                  {row.variant_name && (
                    <span className="ml-1 text-xs text-blue-600 font-medium">({row.variant_name})</span>
                  )}
                  {!row.is_active && (
                    <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-600 font-medium">
                      {t("products_archivedBadge")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-400">{row.sku || "-"}</td>
                <td className="px-4 py-2">{fmt(row.price)}</td>
                <td className="px-4 py-2 text-slate-500">
                  {row.previous_avg_cost > 0 && row.previous_avg_cost !== row.avg_cost ? (
                    <span>
                      <span className="line-through text-slate-300">{fmt(row.previous_avg_cost)}</span>
                      {" → "}
                      <span className="font-medium text-slate-700">{fmt(row.avg_cost)}</span>
                    </span>
                  ) : (
                    fmt(row.avg_cost)
                  )}
                </td>
                <td className={`px-4 py-2 ${row.stock_qty <= 5 ? "text-red-600 font-medium" : ""}`}>
                  {row.stock_qty}
                </td>
                <td className="px-4 py-2 text-right space-x-2">
                  <Link href={`/products/${row.product_id}`} className="text-slate-500 text-xs font-medium">
                    {t("products_view")}
                  </Link>
                  <Link href={`/products/${row.product_id}/edit`} className="text-blue-600 text-xs font-medium">
                    {t("products_edit")}
                  </Link>
                  {!row.variant_id && (
                    <button onClick={() => openAvailability(row.product_id, row.display_name)}
                      className="text-slate-500 text-xs font-medium">
                      {t("products_availability")}
                    </button>
                  )}
                  {row.is_active ? (
                    <button
                      onClick={() => handleDelete(row.product_id)}
                      className="text-red-600 text-xs font-medium"
                    >
                      {t("products_delete")}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleToggleActive(row.product_id)}
                      className="text-green-600 text-xs font-medium"
                    >
                      {t("products_restore")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  {loading ? "…" : t("products_empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {availRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("products_availability")}</h3>
            <p className="text-sm text-slate-500 mb-4">{availRow.name}</p>

            <div className="space-y-2 mb-4">
              {stores.filter((st) => !st.is_warehouse).map((st) => {
                const on = !availOff.has(st.id);
                return (
                  <label key={st.id}
                    className="flex items-center justify-between border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                    <span className="text-sm">{st.name}</span>
                    <input type="checkbox" checked={on} onChange={() => toggleAvailability(st.id)} />
                  </label>
                );
              })}
            </div>

            <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-4">
              {t("products_availabilityHint")}
            </p>

            <button onClick={() => setAvailRow(null)}
              className="w-full py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
              {t("products_cancel")}
            </button>
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
