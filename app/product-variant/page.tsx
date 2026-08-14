"use client";

import { useEffect, useState } from "react";
import { supabase, Product, ProductVariant } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type VariantRow = ProductVariant & { productName: string };

export default function ProductVariantPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [productId, setProductId] = useState("");
  const [variantName, setVariantName] = useState("");
  const [sku, setSku] = useState("");
  const [priceOverride, setPriceOverride] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "product-variant")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "product-variant")) return null;

  async function load() {
    const { data: prods } = await supabase.from("products").select("*").order("name");
    setProducts(prods || []);

    const { data: vars } = await supabase
      .from("product_variants")
      .select("*, products(name)")
      .order("created_at", { ascending: false });
    setVariants(
      ((vars as any[]) || []).map((v) => ({ ...v, productName: v.products?.name || "-" }))
    );
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function openNew() {
    setProductId("");
    setVariantName("");
    setSku("");
    setPriceOverride("");
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!productId || !variantName.trim()) return showToast(t("productVariant_required"));
    try {
      const { error } = await supabase.from("product_variants").insert({
        product_id: productId,
        variant_name: variantName.trim(),
        sku: sku.trim() || null,
        price_override: priceOverride ? Number(priceOverride) : null,
      });
      if (error) throw error;
      showToast(t("loyaltyTiers_saved"));
      setShowForm(false);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    }
  }

  async function updatePrice(id: string, value: string) {
    const price = value.trim() === "" ? null : Number(value);
    if (price !== null && (isNaN(price) || price < 0)) return showToast(t("products_priceInvalid"));
    const { error } = await supabase.from("product_variants").update({ price_override: price }).eq("id", id);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("productVariant_priceSaved"));
    await load();
  }

  async function handleDelete(id: string) {
    if (!confirm(t("productCategory_deleteConfirm"))) return;
    await supabase.from("product_variants").delete().eq("id", id);
    await load();
  }

  return (
    <div className="pt-4 max-w-2xl">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_productVariant")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("productVariant_addNew")}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-4">{t("productVariant_note")}</p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[550px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("stockIn_product")}</th>
              <th className="text-left px-4 py-2">{t("productVariant_variantName")}</th>
              <th className="text-left px-4 py-2">{t("products_sku")}</th>
              <th className="text-left px-4 py-2">{t("productVariant_priceOverride")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr key={v.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{v.productName}</td>
                <td className="px-4 py-2 font-medium">{v.variant_name}</td>
                <td className="px-4 py-2 text-slate-400">{v.sku || "-"}</td>
                <td className="px-4 py-2">
                  <input
                    type="number"
                    className="w-28 border border-slate-200 rounded px-2 py-1 text-sm"
                    defaultValue={v.price_override ?? ""}
                    placeholder={t("products_price")}
                    onBlur={(e) => updatePrice(v.id, e.target.value)}
                  />
                </td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => handleDelete(v.id)} className="text-red-600 text-xs font-medium">
                    {t("products_delete")}
                  </button>
                </td>
              </tr>
            ))}
            {variants.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleSave} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("productVariant_addNew")}</h3>

            <label className="text-sm text-slate-600">{t("stockIn_product")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              required
            >
              <option value="">{t("stockIn_selectPlaceholder")}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("productVariant_variantName")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={variantName}
              onChange={(e) => setVariantName(e.target.value)}
              placeholder="Size: L, Color: Blue..."
              required
            />

            <label className="text-sm text-slate-600">{t("products_sku")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder={t("stockIn_selectPlaceholder") ? "optional" : ""}
            />

            <label className="text-sm text-slate-600">{t("productVariant_priceOverride")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={priceOverride}
              onChange={(e) => setPriceOverride(e.target.value)}
              placeholder="optional"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("products_cancel")}
              </button>
              <button type="submit" className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold">
                {t("products_save")}
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
