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
  // What the manufacturer printed on the box. Kept apart from our own
  // code so a scan finds the item whichever label is facing up.
  const [supplierCode, setSupplierCode] = useState("");
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

  // A package is this product sold as one scan while its parts come out of
  // stock. It lives here rather than on a page of its own, because what goes
  // in a package is part of what the product IS.
  const [parts, setParts] = useState<
    { id: string; component_product_id: string; qty: number; name: string; price: number }[]
  >([]);
  const [allProducts, setAllProducts] = useState<
    { id: string; name: string; sku: string | null; price: number | null; is_package: boolean | null }[]
  >([]);
  const [partPick, setPartPick] = useState("");
  const [partQty, setPartQty] = useState("1");

  // Units of measure. Stock is always counted in the base unit — a carton of
  // twelve takes twelve pieces off the shelf — so the extra units are only
  // ever a way of saying "twelve of those" when buying or selling.
  type UomRow = { id?: string; code: string; name: string; factor: string; barcode: string; price: string };
  const [uoms, setUoms] = useState<UomRow[]>([]);
  const [baseUom, setBaseUom] = useState("PC");

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
    supabase.from("products")
      .select("id,name,sku,price,is_package")
      .eq("is_active", true).order("name").limit(3000)
      .then(({ data }) => setAllProducts((data as never) || []));
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
      const [{ data: p }, { data: vs }, { data: us }, { data: inv }] = await Promise.all([
        supabase.from("products").select("*").eq("id", productId).maybeSingle(),
        supabase.from("product_variants").select("*").eq("product_id", productId).order("created_at").limit(200),
        supabase.from("product_uoms").select("*").eq("product_id", productId).is("variant_id", null).order("sort_order"),
        supabase.from("store_inventory").select("*")
          .eq("product_id", productId).eq("store_id", storeId).is("variant_id", null).maybeSingle(),
      ]);
      if (!live) return;
      const prod = p as Product | null;
      if (!prod) { showToast("❌ not found"); setLoading(false); return; }
      setName(prod.name);
      setSku(prod.sku || "");
      supabase.from("product_barcodes")
        .select("barcode").eq("product_id", productId)
        .eq("kind", "supplier").eq("is_active", true).limit(1)
        .then(({ data }) => setSupplierCode(((data as any[]) || [])[0]?.barcode || ""));
      setPrice(String(prod.price ?? ""));
      setCategoryId(prod.category_id || "");
      setMinPrice(prod.min_price == null ? "" : String(prod.min_price));
      setIsConsignment(!!prod.is_consignment);
      setRequiresExpiry(!!prod.requires_expiry);
      setAllowDiscount(prod.allow_discount !== false);
      setAllowPromotion(prod.allow_promotion !== false);
      setExistingVariants((vs as ProductVariant[]) || []);
      const unitRows = (us as any[]) || [];
      const theBase = unitRows.find((u) => u.is_base);
      if (theBase) setBaseUom(theBase.code);
      setUoms(
        unitRows
          .filter((u) => !u.is_base)
          .map((u) => ({
            id: u.id, code: u.code, name: u.name || "",
            factor: String(u.factor ?? ""),
            barcode: u.barcode || "", price: u.price == null ? "" : String(u.price),
          }))
      );
      loadParts();
      const row = inv as { stock_qty: number; avg_cost: number } | null;
      setStockQty(row ? String(row.stock_qty) : "0");
      setAvgCost(row ? String(row.avg_cost) : "0");
      setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, storeId]);

  async function loadParts() {
    if (!productId) return;
    const { data } = await supabase
      .from("product_packages")
      .select("id, component_product_id, qty")
      .eq("package_product_id", productId);
    const rows = (data as { id: string; component_product_id: string; qty: number }[]) || [];
    setParts(
      rows.map((r) => {
        const pr = allProducts.find((x) => x.id === r.component_product_id);
        return {
          ...r,
          name: pr?.name || r.component_product_id,
          price: Number(pr?.price) || 0,
        };
      })
    );
  }

  async function addPart() {
    if (!productId) return showToast("Save the product first");
    if (!partPick) return showToast("Pick what goes in it");
    const q = Number(partQty);
    if (!(q > 0)) return showToast("Quantity has to be above zero");
    const { error } = await supabase.from("product_packages").insert({
      package_product_id: productId,
      component_product_id: partPick,
      qty: q,
    });
    if (error) return showToast("\u274c " + error.message);
    setPartPick("");
    setPartQty("1");
    await loadParts();
  }

  async function removePart(id: string) {
    const { error } = await supabase.from("product_packages").delete().eq("id", id);
    if (error) return showToast("\u274c " + error.message);
    await loadParts();
  }

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

    if (!baseUom.trim()) return showToast(t("products_baseUnitRequired"));
    for (const u of uoms) {
      const touched = u.code.trim() || u.name.trim() || u.factor.trim();
      if (!touched) continue;
      if (!u.code.trim()) return showToast(t("products_unitCodeRequired"));
      const f = Number(u.factor);
      if (!(f > 1)) return showToast(t("products_unitFactorRequired"));
      if (u.code.trim().toUpperCase() === baseUom.trim().toUpperCase()) {
        return showToast(t("products_unitDuplicate"));
      }
    }
    {
      const codes = uoms
        .map((u) => u.code.trim().toUpperCase())
        .filter(Boolean);
      if (new Set(codes).size !== codes.length) {
        return showToast(t("products_unitDuplicate"));
      }
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
      let savedId: string | null = null;
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
        savedId = created.id;

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
      const codeOwner = productId || savedId;
      if (codeOwner) {
        await supabase.from("product_barcodes").delete()
          .eq("product_id", codeOwner).eq("kind", "supplier");
        if (supplierCode.trim()) {
          const { error: bErr } = await supabase.from("product_barcodes").insert({
            product_id: codeOwner, variant_id: null,
            barcode: supplierCode.trim(), kind: "supplier", is_active: true,
          });
          if (bErr) throw bErr;
        }
      }

      // The base unit is what stock is counted in, so it exists even when
      // nobody adds a second unit. Written after the product so there is an
      // id to hang it on.
      const pid = productId || savedId;
      if (pid) {
        const base = (baseUom.trim() || "PC").toUpperCase();
        const { data: haveBase } = await supabase
          .from("product_uoms").select("id").eq("product_id", pid)
          .is("variant_id", null).eq("is_base", true).maybeSingle();
        if (haveBase) {
          await supabase.from("product_uoms")
            .update({ code: base, name: base, factor: 1 }).eq("id", haveBase.id);
        } else {
          await supabase.from("product_uoms").insert({
            product_id: pid, code: base, name: base, factor: 1,
            is_base: true, sort_order: 0,
          });
        }

        for (let n = 0; n < uoms.length; n++) {
          const u = uoms[n];
          const code = u.code.trim().toUpperCase();
          const factor = Number(u.factor);
          if (!code || !(factor > 1)) continue;
          const row = {
            product_id: pid,
            code,
            name: u.name.trim() || code,
            factor,
            barcode: u.barcode.trim() || null,
            price: u.price.trim() ? Number(u.price) : null,
            is_base: false,
            sort_order: n + 1,
          };
          if (u.id) await supabase.from("product_uoms").update(row).eq("id", u.id);
          else await supabase.from("product_uoms").insert(row);
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

          {/* The code printed on the supplier's own carton. The warehouse scans
              that, not our SKU, so it has to be findable on its own. */}
          <div>
            <label className={label}>{t("products_supplierCode")}</label>
            <input className={field} value={supplierCode}
              placeholder="8851234567890"
              onChange={(e) => setSupplierCode(e.target.value)} />
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

      {/* How this product is counted, bought and sold. The base unit is the
          one the shelf is counted in; everything else is a multiple of it. */}
      <div className={card}>
        <h3 className="text-sm font-medium mb-1">{t("products_units")}</h3>
        <p className="text-xs text-slate-400 mb-3">{t("products_unitsHint")}</p>

        <div className="sm:w-40 mb-4">
          <label className={label}>{t("products_baseUnit")}</label>
          <input className={field} value={baseUom} onChange={(e) => setBaseUom(e.target.value)}
            placeholder="PC" />
        </div>

        {uoms.length > 0 && (
          <div className="space-y-2 mb-3">
            {uoms.map((u, n) => (
              <div key={n} className="flex flex-wrap items-end gap-2">
                <div className="w-20">
                  <label className={label}>{t("products_unitCode")}</label>
                  <input className={field} value={u.code} placeholder="CTN"
                    onChange={(e) => setUoms((r) => r.map((x, i) => i === n ? { ...x, code: e.target.value } : x))} />
                </div>
                <div className="flex-1 min-w-[110px]">
                  <label className={label}>{t("products_unitName")}</label>
                  <input className={field} value={u.name} placeholder="Carton"
                    onChange={(e) => setUoms((r) => r.map((x, i) => i === n ? { ...x, name: e.target.value } : x))} />
                </div>
                <div className="w-24">
                  <label className={label}>{t("products_unitFactor")}</label>
                  <input type="number" className={field} value={u.factor} placeholder="12"
                    onChange={(e) => setUoms((r) => r.map((x, i) => i === n ? { ...x, factor: e.target.value } : x))} />
                </div>
                <div className="w-32">
                  <label className={label}>{t("products_unitBarcode")}</label>
                  <input className={field} value={u.barcode}
                    onChange={(e) => setUoms((r) => r.map((x, i) => i === n ? { ...x, barcode: e.target.value } : x))} />
                </div>
                <div className="w-28">
                  <label className={label}>{t("products_unitPrice")}</label>
                  <input type="number" className={field} value={u.price}
                    onChange={(e) => setUoms((r) => r.map((x, i) => i === n ? { ...x, price: e.target.value } : x))} />
                </div>
                <button type="button" onClick={() => setUoms((r) => r.filter((_, i) => i !== n))}
                  className="text-red-600 text-xs pb-2">✕</button>
                {Number(u.factor) > 0 && u.code.trim() && (
                  <p className="w-full text-xs text-slate-400">
                    1 {u.code.trim().toUpperCase()} = {Number(u.factor)} {baseUom.trim().toUpperCase() || "PC"}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <button type="button"
          onClick={() => setUoms((r) => [...r, { code: "", name: "", factor: "", barcode: "", price: "" }])}
          className="text-sm text-blue-600">
          + {t("products_addUnit")}
        </button>
      </div>

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

      {/* Package contents. A package is sold as one scan and its parts come
          out of stock, so what is in it belongs with the product itself. */}
      {productId && (
        <div className={card}>
          <h3 className="text-sm font-medium mb-1">Package contents</h3>
          <p className="text-xs text-slate-500 mb-3">
            Leave this empty for an ordinary product. Put items in it and this
            becomes a package: one barcode, one price, and selling it takes the
            items below out of stock.
          </p>

          {parts.length > 0 && (
            <table className="w-full text-sm mb-3">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="text-left py-1">Item</th>
                  <th className="text-right py-1 w-20">Qty</th>
                  <th className="text-right py-1 w-32">On its own</th>
                  <th className="w-16"></th>
                </tr>
              </thead>
              <tbody>
                {parts.map((pt) => (
                  <tr key={pt.id} className="border-t border-slate-100">
                    <td className="py-1.5">{pt.name}</td>
                    <td className="py-1.5 text-right">{pt.qty}</td>
                    <td className="py-1.5 text-right text-slate-500">
                      {(pt.qty * pt.price).toLocaleString()} MMK
                    </td>
                    <td className="py-1.5 text-right">
                      <button type="button" onClick={() => removePart(pt.id)}
                        className="text-red-600 text-xs">
                        {t("products_delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex gap-2">
            <select className={field} value={partPick}
              onChange={(e) => setPartPick(e.target.value)}>
              <option value="">-</option>
              {allProducts
                .filter((x) => !x.is_package && x.id !== productId &&
                  !parts.some((pt) => pt.component_product_id === x.id))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}{x.sku ? ` (${x.sku})` : ""}
                  </option>
                ))}
            </select>
            <input type="number" className={field + " w-20 text-right"}
              value={partQty} onChange={(e) => setPartQty(e.target.value)} />
            <button type="button" onClick={addPart}
              className="shrink-0 px-4 bg-slate-900 text-white rounded-lg text-sm font-medium">
              Add
            </button>
          </div>

          {parts.length > 0 && (
            <div className="mt-3 text-sm flex justify-between border-t border-slate-100 pt-2">
              <span className="text-slate-500">
                Parts bought separately{" "}
                {parts.reduce((n2, pt) => n2 + pt.qty * pt.price, 0).toLocaleString()} MMK
              </span>
              <span className="font-semibold">
                Package price {(Number(price) || 0).toLocaleString()} MMK
              </span>
            </div>
          )}
        </div>
      )}

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
