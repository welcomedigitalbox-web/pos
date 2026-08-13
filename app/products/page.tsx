"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, Product, ProductCategory, ProductVariant, fetchProductsWithStock, upsertStoreInventory } from "@/lib/supabase";
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
};

const emptyForm: FormState = { id: null, name: "", sku: "", price: "", stock_qty: "", avg_cost: "", category_id: "" };

export default function ProductsPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [editingVariants, setEditingVariants] = useState<ProductVariant[]>([]);
  const [newVariantName, setNewVariantName] = useState("");
  const [newVariantSku, setNewVariantSku] = useState("");
  const [newVariantPrice, setNewVariantPrice] = useState("");
  const [form, setForm] = useState<FormState>(emptyForm);
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
    const data = await fetchProductsWithStock(storeId, true);
    setProducts(data);
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
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  function generateSku() {
    const storePrefix = storeId.replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase();
    const timestampPart = Date.now().toString().slice(-6);
    const randomPart = Math.floor(Math.random() * 90 + 10); // 2-digit
    return `${storePrefix}-${timestampPart}${randomPart}`;
  }

  function openNew() {
    setForm({ ...emptyForm, sku: generateSku() });
    setEditingVariants([]);
    setShowForm(true);
  }

  async function openEdit(p: Product) {
    setForm({
      id: p.id,
      name: p.name,
      sku: p.sku || "",
      price: String(p.price),
      stock_qty: String(p.stock_qty),
      avg_cost: String(p.avg_cost),
      category_id: p.category_id || "",
    });
    await loadVariants(p.id);
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return showToast(t("products_nameRequired"));
    if (!form.sku.trim()) return showToast(t("products_skuRequired"));
    const price = Number(form.price);
    const stock_qty = Number(form.stock_qty);
    const avg_cost = form.avg_cost === "" ? 0 : Number(form.avg_cost);
    if (isNaN(price) || price < 0) return showToast(t("products_priceInvalid"));
    if (isNaN(stock_qty) || stock_qty < 0) return showToast(t("products_stockInvalid"));
    if (isNaN(avg_cost) || avg_cost < 0) return showToast(t("products_avgCostInvalid"));

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
            updated_at: new Date().toISOString(),
          })
          .eq("id", form.id);
        if (error) throw error;
        await upsertStoreInventory(storeId, form.id, { stock_qty, avg_cost });
        showToast(t("products_updateSuccess"));
      } else {
        const { data: created, error } = await supabase
          .from("products")
          .insert({
            name: form.name.trim(),
            sku: form.sku.trim() || null,
            price,
            category_id: form.category_id || null,
            store_id: storeId,
          })
          .select()
          .single();
        if (error) throw error;
        await upsertStoreInventory(storeId, created.id, { stock_qty, avg_cost });
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

  async function addVariant() {
    if (!form.id || !newVariantName.trim()) return;
    const { error } = await supabase.from("product_variants").insert({
      product_id: form.id,
      variant_name: newVariantName.trim(),
      sku: newVariantSku.trim() || null,
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

  async function deleteVariant(id: string) {
    await supabase.from("product_variants").delete().eq("id", id);
    if (form.id) await loadVariants(form.id);
  }

  async function handleToggleActive(p: Product) {
    await supabase.from("products").update({ is_active: !p.is_active }).eq("id", p.id);
    showToast(p.is_active ? t("products_archived") : t("products_restored"));
    await load();
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("products_title")} ({storeId})</h2>
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
              <th className="text-left px-4 py-2">{t("products_stock")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className={`border-t border-slate-100 ${!p.is_active ? "opacity-50 bg-slate-50" : ""}`}>
                <td className="px-4 py-2">
                  {p.name}
                  {!p.is_active && (
                    <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-600 font-medium">
                      {t("products_archivedBadge")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-400">{p.sku || "-"}</td>
                <td className="px-4 py-2">{fmt(p.price)}</td>
                <td className="px-4 py-2 text-slate-500">
                  {p.previous_avg_cost > 0 && p.previous_avg_cost !== p.avg_cost ? (
                    <span>
                      <span className="line-through text-slate-300">{fmt(p.previous_avg_cost)}</span>
                      {" → "}
                      <span className="font-medium text-slate-700">{fmt(p.avg_cost)}</span>
                    </span>
                  ) : (
                    fmt(p.avg_cost)
                  )}
                </td>
                <td className={`px-4 py-2 ${p.stock_qty <= 5 ? "text-red-600 font-medium" : ""}`}>
                  {p.stock_qty}
                </td>
                <td className="px-4 py-2 text-right space-x-2">
                  <Link href={`/products/${p.id}`} className="text-slate-500 text-xs font-medium">
                    {t("products_view")}
                  </Link>
                  <button
                    onClick={() => openEdit(p)}
                    className="text-blue-600 text-xs font-medium"
                  >
                    {t("products_edit")}
                  </button>
                  {p.is_active ? (
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="text-red-600 text-xs font-medium"
                    >
                      {t("products_delete")}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleToggleActive(p)}
                      className="text-green-600 text-xs font-medium"
                    >
                      {t("products_restore")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {products.length === 0 && (
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

            <label className="text-sm text-slate-600">{t("products_stockQty")}</label>
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

            {form.id && (
              <div className="mb-4 border-t border-slate-100 pt-3">
                <label className="text-sm text-slate-600 block mb-2">{t("nav_productVariant")}</label>
                {editingVariants.length > 0 && (
                  <div className="space-y-1 mb-2">
                    {editingVariants.map((v) => (
                      <div key={v.id} className="flex items-center justify-between text-xs bg-slate-50 rounded px-2 py-1.5">
                        <span>
                          {v.variant_name}
                          {v.sku && <span className="text-slate-400"> · {v.sku}</span>}
                          {v.price_override && (
                            <span className="text-slate-400"> · {v.price_override.toLocaleString()} MMK</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => deleteVariant(v.id)}
                          className="text-red-500 ml-2"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-1">
                  <input
                    className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    value={newVariantName}
                    onChange={(e) => setNewVariantName(e.target.value)}
                    placeholder={t("productVariant_variantName")}
                  />
                  <input
                    className="w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                    value={newVariantSku}
                    onChange={(e) => setNewVariantSku(e.target.value)}
                    placeholder={t("products_sku")}
                  />
                  <button
                    type="button"
                    onClick={addVariant}
                    className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs font-medium"
                  >
                    +
                  </button>
                </div>
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
