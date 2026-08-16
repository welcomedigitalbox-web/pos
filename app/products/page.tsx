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
};

const emptyForm: FormState = { id: null, name: "", sku: "", price: "", stock_qty: "", avg_cost: "", category_id: "", is_consignment: false, requires_expiry: false };

export default function ProductsPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const [items, setItems] = useState<SellableItem[]>([]);
  const [rawProducts, setRawProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [editingVariants, setEditingVariants] = useState<ProductVariant[]>([]);
  const [variantStock, setVariantStock] = useState<Record<string, number>>({});
  const [newVariantName, setNewVariantName] = useState("");
  const [newVariantSku, setNewVariantSku] = useState("");
  const [newVariantPrice, setNewVariantPrice] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [withVariants, setWithVariants] = useState(false);
  const [variationTheme, setVariationTheme] = useState("Size");
  const [draftVariants, setDraftVariants] = useState<
    { name: string; sku: string; price: string }[]
  >([{ name: "", sku: "", price: "" }]);
  const [showForm, setShowForm] = useState(false);
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
    const { data: raw } = await supabase.from("products").select("*").order("name");
    setRawProducts((raw as Product[]) || []);
    const data = await fetchSellableItems(storeId, true);

    // Stock lives per location; the catalog view shows the company-wide total
    const { data: invRows } = await supabase
      .from("store_inventory")
      .select("product_id, variant_id, stock_qty, avg_cost");

    const key = (p: string, v: string | null) => `${p}:${v || "base"}`;
    const totals = new Map<string, { qty: number; value: number }>();
    for (const r of (invRows as any[]) || []) {
      const k = key(r.product_id, r.variant_id);
      const cur = totals.get(k) || { qty: 0, value: 0 };
      cur.qty += Number(r.stock_qty);
      cur.value += Number(r.stock_qty) * Number(r.avg_cost);
      totals.set(k, cur);
    }

    const merged = data.map((i) => {
      const agg = totals.get(key(i.product_id, i.variant_id)) || { qty: 0, value: 0 };
      return {
        ...i,
        stock_qty: agg.qty,
        avg_cost: agg.qty > 0 ? agg.value / agg.qty : 0,
      };
    });
    setItems(merged);
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

  function openNew() {
    setForm({ ...emptyForm, sku: generateSku() });
    setWithVariants(false);
    setVariationTheme("Size");
    setDraftVariants([{ name: "", sku: "", price: "" }]);
    setEditingVariants([]);
    setShowForm(true);
  }

  async function openEdit(row: SellableItem) {
    const parent = rawProducts.find((p) => p.id === row.product_id);
    if (!parent) return;
    setForm({
      id: parent.id,
      name: parent.name,
      sku: parent.sku || "",
      price: String(parent.price),
      // Stock/cost only apply to products with no variants; variant stock lives per-variant
      stock_qty: row.variant_id ? "" : String(row.stock_qty),
      avg_cost: row.variant_id ? "" : String(row.avg_cost),
      category_id: parent.category_id || "",
      is_consignment: !!parent.is_consignment,
      requires_expiry: !!parent.requires_expiry,
    });
    await loadVariants(parent.id);
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return showToast(t("products_nameRequired"));
    if (!form.sku.trim()) return showToast(t("products_skuRequired"));
    const price = Number(form.price);
    const hasVariants = editingVariants.length > 0;
    const stock_qty = form.stock_qty === "" ? 0 : Number(form.stock_qty);
    const avg_cost = form.avg_cost === "" ? 0 : Number(form.avg_cost);
    if (isNaN(price) || price < 0) return showToast(t("products_priceInvalid"));
    const buildingVariants = withVariants && draftVariants.some((v) => v.name.trim());
    if (!hasVariants && !buildingVariants && (isNaN(stock_qty) || stock_qty < 0))
      return showToast(t("products_stockInvalid"));
    if (!hasVariants && !buildingVariants && (isNaN(avg_cost) || avg_cost < 0))
      return showToast(t("products_avgCostInvalid"));

    setSaving(true);
    try {
      if (form.id) {
        const { error } = await supabase
          .from("products")
          .update({
            name: form.name.trim(),
            sku: form.sku.trim() || null,
            price,
            category_id: form.category_id || null,
            is_consignment: form.is_consignment,
            requires_expiry: form.requires_expiry,
            updated_at: new Date().toISOString(),
          })
          .eq("id", form.id);
        if (error) throw error;
        if (!hasVariants) await upsertStoreInventory(storeId, form.id, null, { stock_qty, avg_cost });
        showToast(t("products_updateSuccess"));
      } else {
        const { data: created, error } = await supabase
          .from("products")
          .insert({
            name: form.name.trim(),
            sku: form.sku.trim() || null,
            price,
            category_id: form.category_id || null,
            is_consignment: form.is_consignment,
            requires_expiry: form.requires_expiry,
            store_id: storeId,
          })
          .select()
          .single();
        if (error) throw error;

        const filledVariants = draftVariants.filter((v) => v.name.trim());
        if (withVariants && filledVariants.length) {
          // The parent becomes a grouping row; stock and price live on the children
          await supabase.from("product_variants").insert(
            filledVariants.map((v) => ({
              product_id: created.id,
              variant_name: v.name.trim(),
              // Fall back to the parent SKU plus the variant name so scanning works
              sku:
                v.sku.trim() ||
                `${form.sku.trim()}-${v.name.trim().toUpperCase().replace(/\s+/g, "-")}`,
              price_override: v.price.trim() ? Number(v.price) : price,
            }))
          );
          await supabase
            .from("products")
            .update({ variation_theme: variationTheme })
            .eq("id", created.id);
        } else {
          await upsertStoreInventory(storeId, created.id, null, { stock_qty, avg_cost });
        }

        showToast(t("products_createSuccess"));
      }
      setShowForm(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
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
        <button
          onClick={openNew}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
        >
          {t("products_addNew")}
        </button>
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
                  <button onClick={() => openEdit(row)} className="text-blue-600 text-xs font-medium">
                    {t("products_edit")}
                  </button>
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
                  {t("products_empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form
            onSubmit={handleSave}
            className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg"
          >
            <h3 className="font-semibold text-lg mb-4">
              {form.id ? t("products_modalEditTitle") : t("products_modalNewTitle")}
            </h3>

            <label className="text-sm text-slate-600">{t("products_productName")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />

            <label className="text-sm text-slate-600">{t("products_skuOptional")}</label>
            <div className="flex gap-1 mt-1 mb-1">
              <input
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                required
              />
              {!form.id && (
                <button
                  type="button"
                  onClick={() => setForm({ ...form, sku: generateSku() })}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-500"
                  title={t("products_skuRegenerate")}
                >
                  🔄
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400 mb-3">
              {!form.id ? t("products_skuAutoHint") : ""}
            </p>

            <label className="text-sm text-slate-600">{t("products_priceMmk")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              required
            />

            <label className="text-sm text-slate-600">{t("nav_productCategory")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={form.category_id}
              onChange={(e) => setForm({ ...form, category_id: e.target.value })}
            >
              <option value="">{t("customers_tierNone")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap gap-4 mb-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_consignment}
                  onChange={(e) => setForm({ ...form, is_consignment: e.target.checked })}
                />
                {t("products_isConsignment")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.requires_expiry}
                  onChange={(e) => setForm({ ...form, requires_expiry: e.target.checked })}
                />
                {t("products_requiresExpiry")}
              </label>
            </div>

            {editingVariants.length === 0 ? (
              <>
                <label className="flex items-start gap-2 text-sm mb-3 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={withVariants}
                    onChange={(e) => setWithVariants(e.target.checked)} />
                  <span>
                    <span className="font-medium">{t("products_hasVariants")}</span>
                    <span className="block text-xs text-slate-500">{t("products_hasVariantsHint")}</span>
                  </span>
                </label>

                {withVariants && (
                  <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-3 mb-4">
                    <label className="text-sm text-slate-600">{t("products_variationTheme")}</label>
                    <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
                      value={variationTheme} onChange={(e) => setVariationTheme(e.target.value)}>
                      <option value="Size">Size</option>
                      <option value="Color">Color</option>
                      <option value="Flavour">Flavour</option>
                      <option value="Pack">Pack</option>
                    </select>

                    <div className="grid grid-cols-[1fr_1.2fr_0.9fr_auto] gap-1 text-[10px] text-slate-400 uppercase mb-1">
                      <span>{t("products_variantName")}</span>
                      <span>{t("products_sku")}</span>
                      <span>{t("products_price")}</span>
                      <span></span>
                    </div>

                    {draftVariants.map((v, idx) => (
                      <div key={idx} className="grid grid-cols-[1fr_1.2fr_0.9fr_auto] gap-1 mb-1">
                        <input
                          className="border border-slate-200 rounded px-2 py-1.5 text-sm"
                          placeholder="M"
                          value={v.name}
                          onChange={(e) => {
                            const next = [...draftVariants];
                            next[idx] = { ...next[idx], name: e.target.value };
                            setDraftVariants(next);
                          }}
                        />
                        <input
                          className="border border-slate-200 rounded px-2 py-1.5 text-sm"
                          placeholder={
                            v.name.trim()
                              ? `${form.sku}-${v.name.trim().toUpperCase()}`
                              : t("products_skuAuto")
                          }
                          value={v.sku}
                          onChange={(e) => {
                            const next = [...draftVariants];
                            next[idx] = { ...next[idx], sku: e.target.value };
                            setDraftVariants(next);
                          }}
                        />
                        <input
                          type="number"
                          className="border border-slate-200 rounded px-2 py-1.5 text-sm"
                          placeholder={form.price || "0"}
                          value={v.price}
                          onChange={(e) => {
                            const next = [...draftVariants];
                            next[idx] = { ...next[idx], price: e.target.value };
                            setDraftVariants(next);
                          }}
                        />
                        <button type="button" className="text-red-500 px-1"
                          onClick={() => setDraftVariants(draftVariants.filter((_, i) => i !== idx))}>
                          ✕
                        </button>
                      </div>
                    ))}

                    <button type="button"
                      onClick={() => setDraftVariants([...draftVariants, { name: "", sku: "", price: "" }])}
                      className="w-full py-1.5 border border-slate-300 rounded text-xs font-medium mt-1">
                      + {t("products_addVariantRow")}
                    </button>

                    <p className="text-xs text-slate-500 mt-2">{t("products_variantStockHint")}</p>
                  </div>
                )}

                {!withVariants && (
                <>
                <label className="text-sm text-slate-600">
                  {t("products_stockQty")}
                  <span className="text-slate-400 text-xs">
                    {" "}({stores.find((st) => st.id === storeId)?.name || storeId})
                  </span>
                </label>
                <p className="text-xs text-slate-400 mb-1">{t("products_openingStockHint")}</p>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
                  value={form.stock_qty}
                  onChange={(e) => setForm({ ...form, stock_qty: e.target.value })}
                  required
                />

                <label className="text-sm text-slate-600">{t("products_avgCostMmk")}</label>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
                  value={form.avg_cost}
                  onChange={(e) => setForm({ ...form, avg_cost: e.target.value })}
                  placeholder="0"
                />
                <p className="text-xs text-slate-400 -mt-3 mb-4">{t("products_avgCostWarning")}</p>
                </>
                )}
              </>
            ) : (
              <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 mb-4">
                <p className="text-xs text-blue-700">{t("products_variantStockNote")}</p>
              </div>
            )}

            {form.id && (
              <div className="mb-4 border-t border-slate-100 pt-3">
                <label className="text-sm text-slate-600 block mb-2">{t("nav_productVariant")}</label>
                {editingVariants.length > 0 && (
                  <div className="space-y-1 mb-2">
                    <div className="flex items-center gap-1 text-[10px] text-slate-400 px-2">
                      <span className="flex-1">{t("productVariant_variantName")}</span>
                      <span className="w-24">{t("products_price")}</span>
                      <span className="w-20">
                        {t("products_stockQty")}
                        <span className="block text-[9px] text-slate-300 leading-none">
                          {stores.find((st) => st.id === storeId)?.name || storeId}
                        </span>
                      </span>
                      <span className="w-4"></span>
                    </div>
                    {editingVariants.map((v) => (
                      <div key={v.id} className="flex items-center gap-1 text-xs bg-slate-50 rounded px-2 py-1.5">
                        <span className="flex-1 min-w-0 truncate">
                          {v.variant_name}
                          {v.sku && <span className="text-slate-400"> · {v.sku}</span>}
                        </span>
                        <input
                          type="number"
                          className="w-24 border border-slate-200 rounded px-2 py-1 text-xs bg-white"
                          defaultValue={v.price_override ?? ""}
                          placeholder={t("products_price")}
                          onBlur={(e) => updateVariantPrice(v.id, e.target.value)}
                        />
                        <input
                          type="number"
                          className="w-20 border border-slate-200 rounded px-2 py-1 text-xs bg-white"
                          defaultValue={variantStock[v.id] ?? 0}
                          placeholder={t("products_stockQty")}
                          onBlur={(e) => updateVariantStock(v.id, e.target.value)}
                        />
                        <button
                          type="button"
                          onClick={() => deleteVariant(v.id)}
                          className="text-red-500 ml-1"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-1">
                  <input
                    className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    value={newVariantName}
                    onChange={(e) => setNewVariantName(e.target.value)}
                    placeholder={t("productVariant_variantName")}
                  />
                  <input
                    className="w-28 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    value={newVariantSku}
                    onChange={(e) => setNewVariantSku(e.target.value)}
                    placeholder={newVariantName.trim() ? generateVariantSku(newVariantName) : t("products_sku")}
                  />
                  <input
                    type="number"
                    className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    value={newVariantPrice}
                    onChange={(e) => setNewVariantPrice(e.target.value)}
                    placeholder={t("products_price")}
                  />
                  <button
                    type="button"
                    onClick={addVariant}
                    className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs font-medium"
                  >
                    +
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1">{t("productVariant_priceHint")}<br />{t("productVariant_skuHint")}</p>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("products_cancel")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {saving ? t("products_saving") : t("products_save")}
              </button>
            </div>
          </form>
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
