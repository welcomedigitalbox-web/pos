"use client";

// A product has a name, a price, a floor price, a category, two rules about
// discounting, an expiry requirement, stock in this store, and possibly a set
// of variants each with their own code and price. That is a page's worth of
// decisions, and it was being made in a box floating over the list.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  supabase, Product, ProductCategory, ProductVariant,
  upsertStoreInventory, describeError,
} from "@/lib/supabase";
import { useStore } from "../store-context";
import { useLanguage } from "../language-context";

type Draft = { name: string; sku: string; price: string };

export default function ProductForm({ productId }: { productId?: string }) {
  const { storeId } = useStore();
  const { t } = useLanguage();
  const router = useRouter();

  const [loading, setLoading] = useState(!!productId);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [categories, setCategories] = useState<ProductCategory[]>([]);

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [isConsignment, setIsConsignment] = useState(false);
  const [requiresExpiry, setRequiresExpiry] = useState(false);
  const [allowDiscount, setAllowDiscount] = useState(true);
  const [allowPromotion, setAllowPromotion] = useState(true);
  const [stockQty, setStockQty] = useState("");
  const [avgCost, setAvgCost] = useState("");

  // Variants: a new product builds them from scratch; an existing one shows
  // the ones it already has, which are edited on their own page.
  const [withVariants, setWithVariants] = useState(false);
  const [variationTheme, setVariationTheme] = useState("Size");
  const [drafts, setDrafts] = useState<Draft[]>([{ name: "", sku: "", price: "" }]);
  const [existingVariants, setExistingVariants] = useState<ProductVariant[]>([]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  // A code nobody will type twice: the store, the minute, and two digits.
  function generateSku() {
    const prefix = (storeId || "P").slice(0, 3).toUpperCase();
    const stamp = Date.now().toString().slice(-6);
    const tail = Math.floor(Math.random() * 90 + 10);
    return `${prefix}-${stamp}${tail}`;
  }

  useEffect(() => {
    supabase.from("product_categories").select("*").order("sort_order").limit(500)
      .then(({ data }) => setCategories((data as ProductCategory[]) || []));
  }, []);

  useEffect(() => {
    if (!productId) {
      setSku(generateSku());
      return;
    }
    let live = true;
    (async () => {
      const [{ data: p }, { data: vs }, { data: inv }] = await Promise.all([
        supabase.from("products").select("*").eq("id", productId).maybeSingle(),
        supabase.from("product_variants").select("*").eq("product_id", productId).order("created_at").limit(200),
        supabase.from("store_inventory").select("*")
          .eq("product_id", productId).eq("store_id", storeId).is("variant_id", null).maybeSingle(),
      ]);
      if (!live) return;
      const prod = p as Product | null;
      if (!prod) { showToast("❌ not found"); setLoading(false); return; }
      setName(prod.name);
      setSku(prod.sku || "");
      setPrice(String(prod.price ?? ""));
      setCategoryId(prod.category_id || "");
      setMinPrice(prod.min_price == null ? "" : String(prod.min_price));
      setIsConsignment(!!prod.is_consignment);
      setRequiresExpiry(!!prod.requires_expiry);
      setAllowDiscount(prod.allow_discount !== false);
      setAllowPromotion(prod.allow_promotion !== false);
      setExistingVariants((vs as ProductVariant[]) || []);
      const row = inv as { stock_qty: number; avg_cost: number } | null;
      setStockQty(row ? String(row.stock_qty) : "0");
      setAvgCost(row ? String(row.avg_cost) : "0");
      setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, storeId]);

  const hasVariants = existingVariants.length > 0;
  const buildingVariants = withVariants && drafts.some((d) => d.name.trim());
  // Stock and cost belong to whatever is actually sold. For a product with
  // variants that is each variant, not the grouping row.
  const stockOnThisRow = !hasVariants && !buildingVariants;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return showToast(t("products_nameRequired"));
    if (!sku.trim()) return showToast(t("products_skuRequired"));

    const priceNum = Number(price);
    if (isNaN(priceNum) || priceNum < 0) return showToast(t("products_priceInvalid"));

    const qty = stockQty === "" ? 0 : Number(stockQty);
    const cost = avgCost === "" ? 0 : Number(avgCost);
    if (stockOnThisRow && (isNaN(qty) || qty < 0)) return showToast(t("products_stockInvalid"));
    if (stockOnThisRow && (isNaN(cost) || cost < 0)) return showToast(t("products_avgCostInvalid"));
    if (minPrice !== "" && Number(minPrice) > priceNum) {
      return showToast("❌ Minimum price is above the selling price");
    }

    const payload = {
      name: name.trim(),
      sku: sku.trim() || null,
      price: priceNum,
      category_id: categoryId || null,
      is_consignment: isConsignment,
      requires_expiry: requiresExpiry,
      allow_discount: allowDiscount,
      allow_promotion: allowPromotion,
      min_price: minPrice === "" ? null : Number(minPrice),
    };

    setSaving(true);
    try {
      if (productId) {
        const { error } = await supabase
          .from("products")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", productId);
        if (error) throw error;
        if (!hasVariants) await upsertStoreInventory(storeId, productId, null, { stock_qty: qty, avg_cost: cost });
      } else {
        const { data: created, error } = await supabase
          .from("products").insert({ ...payload, store_id: storeId })
          .select().single();
        if (error) throw error;

        const filled = drafts.filter((d) => d.name.trim());
        if (withVariants && filled.length) {
          const { data: made, error: vErr } = await supabase.from("product_variants").insert(
            filled.map((d) => ({
              product_id: created.id,
              variant_name: d.name.trim(),
              // Falling back to the parent code plus the variant name keeps
              // every sellable thing scannable.
              sku: d.sku.trim() || `${sku.trim()}-${d.name.trim().toUpperCase().replace(/\s+/g, "-")}`,
              price_override: d.price.trim() ? Number(d.price) : priceNum,
            }))
          ).select();
          if (vErr) throw vErr;

          // Without a stock row the till refuses the first sale with
          // "No stock record", which reads like a broken product.
          for (const v of made || []) {
            await upsertStoreInventory(storeId, created.id, v.id, { stock_qty: 0, avg_cost: cost });
          }
          const { error: tErr } = await supabase
            .from("products").update({ variation_theme: variationTheme }).eq("id", created.id);
          if (tErr) throw tErr;
        } else {
          await upsertStoreInventory(storeId, created.id, null, { stock_qty: qty, avg_cost: cost });
        }
      }
      router.push("/products");
      router.refresh();
    } catch (err) {
      showToast("❌ " + describeError(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="pt-6 text-sm text-slate-400">…</div>;

  const field = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm";
  const label = "block text-sm text-slate-600 mb-1";
  const card = "bg-white border border-slate-200 rounded-xl p-5";

  return (
    <form onSubmit={save} className="pt-4 pb-16 max-w-4xl space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">
          {productId ? t("products_modalEditTitle") : t("products_modalNewTitle")}
        </h2>
        <a href="/products" className="text-sm text-slate-500">{t("products_cancel")}</a>
      </div>

      <div className={card}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={label}>{t("products_name")} *</label>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div>
            <label className={label}>{t("products_sku")} *</label>
            <div className="flex gap-2">
              <input className={field} value={sku} onChange={(e) => setSku(e.target.value)} required />
              <button type="button" onClick={() => setSku(generateSku())}
                className="shrink-0 text-xs border border-slate-200 rounded-lg px-3">↻</button>
            </div>
          </div>

          <div>
            <label className={label}>{t("nav_productCategory")}</label>
            <select className={field} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t("customers_tierNone")}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <label className={label}>{t("products_price")}</label>
            <input type="number" className={field} value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>

          <div>
            <label className={label}>Minimum price (blank = none)</label>
            <input type="number" className={field} value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)} placeholder="—" />
          </div>
        </div>
      </div>

      <div className={card}>
        <h3 className="text-sm font-medium mb-3">Rules</h3>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allowDiscount} onChange={(e) => setAllowDiscount(e.target.checked)} />
            Allow discount
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allowPromotion} onChange={(e) => setAllowPromotion(e.target.checked)} />
            Allow promotion
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={requiresExpiry} onChange={(e) => setRequiresExpiry(e.target.checked)} />
            {t("products_requiresExpiry")}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isConsignment} onChange={(e) => setIsConsignment(e.target.checked)} />
            {t("products_isConsignment")}
          </label>
        </div>
      </div>

      {stockOnThisRow && (
        <div className={card}>
          <h3 className="text-sm font-medium mb-3">{storeId}</h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className={label}>{t("products_stockQty")}</label>
              <input type="number" className={field} value={stockQty} onChange={(e) => setStockQty(e.target.value)} />
            </div>
            <div>
              <label className={label}>{t("products_avgCost")}</label>
              <input type="number" className={field} value={avgCost} onChange={(e) => setAvgCost(e.target.value)} />
            </div>
          </div>
        </div>
      )}

      {/* Variants are built with the product and then maintained on their own
          page, so an existing product shows them rather than re-editing them. */}
      {!productId ? (
        <div className={card}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withVariants} onChange={(e) => setWithVariants(e.target.checked)} />
            {t("products_hasVariants")}
          </label>

          {withVariants && (
            <div className="mt-4 space-y-3">
              <div>
                <label className={label}>{t("products_variationTheme")}</label>
                <input className={field + " sm:w-48"} value={variationTheme}
                  onChange={(e) => setVariationTheme(e.target.value)} />
              </div>

              {drafts.map((d, i) => (
                <div key={i} className="grid sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                  <div>
                    <label className={label}>{t("products_variantName")}</label>
                    <input className={field} value={d.name}
                      onChange={(e) => setDrafts(drafts.map((x, k) => k === i ? { ...x, name: e.target.value } : x))} />
                  </div>
                  <div>
                    <label className={label}>{t("products_sku")}</label>
                    <input className={field} value={d.sku} placeholder="auto"
                      onChange={(e) => setDrafts(drafts.map((x, k) => k === i ? { ...x, sku: e.target.value } : x))} />
                  </div>
                  <div>
                    <label className={label}>{t("products_price")}</label>
                    <input type="number" className={field} value={d.price} placeholder={price || "—"}
                      onChange={(e) => setDrafts(drafts.map((x, k) => k === i ? { ...x, price: e.target.value } : x))} />
                  </div>
                  <button type="button" className="text-red-600 text-xs pb-2"
                    onClick={() => setDrafts(drafts.filter((_, k) => k !== i))}>
                    {t("products_delete")}
                  </button>
                </div>
              ))}

              <button type="button" className="text-sm text-blue-600"
                onClick={() => setDrafts([...drafts, { name: "", sku: "", price: "" }])}>
                + {t("products_variantName")}
              </button>
            </div>
          )}
        </div>
      ) : hasVariants ? (
        <div className={card}>
          <h3 className="text-sm font-medium mb-2">{t("products_hasVariants")}</h3>
          <ul className="text-sm text-slate-600 space-y-1">
            {existingVariants.map((v) => (
              <li key={v.id}>{v.variant_name} · {v.sku}</li>
            ))}
          </ul>
          <a href={`/product-variant?product=${productId}`} className="text-sm text-blue-600 mt-3 inline-block">
            {t("products_edit")} →
          </a>
        </div>
      ) : null}

      <div className="flex gap-2 max-w-sm">
        <a href="/products"
          className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium text-center">
          {t("products_cancel")}
        </a>
        <button type="submit" disabled={saving}
          className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
          {saving ? "..." : t("products_save")}
        </button>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </form>
  );
}
