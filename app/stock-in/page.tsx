"use client";

import { useEffect, useState } from "react";
import { supabase, Product, fetchProductsWithStock, upsertStoreInventory } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type PurchaseRow = {
  id: string;
  product_id: string;
  created_at: string;
  supplier: string | null;
  qty: number;
  unit_cost: number;
  total_cost: number;
  new_avg_cost: number;
  expiry_date: string | null;
  remaining_qty: number;
  products: { name: string } | null;
};

export default function StockInPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [history, setHistory] = useState<PurchaseRow[]>([]);

  // form (new / edit) state
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [productId, setProductId] = useState("");
  const [supplier, setSupplier] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [saving, setSaving] = useState(false);

  // password confirm state
  const [pendingAction, setPendingAction] = useState<null | { type: "edit" | "delete"; row: PurchaseRow }>(null);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "stock-in")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadProducts();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "stock-in")) return null;

  async function loadProducts() {
    const data = await fetchProductsWithStock(storeId);
    setProducts(data);
  }

  async function loadHistory() {
    const { data } = await supabase
      .from("stock_purchases")
      .select("*, products(name)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(100);
    setHistory((data as unknown as PurchaseRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  // latest purchase id per product (only this one is editable/deletable)
  const latestByProduct = new Map<string, string>();
  for (const h of history) {
    if (!latestByProduct.has(h.product_id)) latestByProduct.set(h.product_id, h.id);
  }

  const selectedProduct = products.find((p) => p.id === productId);
  const qtyNum = Number(qty) || 0;
  const unitCostNum = Number(unitCost) || 0;

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
      (p.sku || "").toLowerCase().includes(productSearch.toLowerCase())
  );

  let previewAvgCost: number | null = null;
  if (selectedProduct && qtyNum > 0 && unitCostNum >= 0) {
    // baseline stock/cost: if editing, back out this entry's own effect first
    const baseQty = editId ? selectedProduct.stock_qty - (history.find((h) => h.id === editId)?.qty || 0) : selectedProduct.stock_qty;
    const baseCost = editId ? selectedProduct.previous_avg_cost : selectedProduct.avg_cost;
    const existingValue = baseQty * baseCost;
    const newValue = qtyNum * unitCostNum;
    previewAvgCost = (existingValue + newValue) / (baseQty + qtyNum);
  }

  function openNew() {
    setEditId(null);
    setProductId("");
    setProductSearch("");
    setSupplier("");
    setQty("");
    setUnitCost("");
    setExpiryDate("");
    setShowForm(true);
  }

  function openEdit(row: PurchaseRow) {
    const p = products.find((pr) => pr.id === row.product_id);
    setEditId(row.id);
    setProductId(row.product_id);
    setProductSearch(p?.name || "");
    setSupplier(row.supplier || "");
    setQty(String(row.qty));
    setUnitCost(String(row.unit_cost));
    setExpiryDate(row.expiry_date || "");
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProduct) return showToast(t("stockIn_selectProduct"));
    if (qtyNum <= 0) return showToast(t("stockIn_qtyInvalid"));
    if (unitCostNum < 0) return showToast(t("stockIn_costInvalid"));

    setSaving(true);
    try {
      if (editId) {
        // editing latest entry: undo its effect, then reapply with new values
        const baseQty = selectedProduct.stock_qty - (history.find((h) => h.id === editId)?.qty || 0);
        const baseCost = selectedProduct.previous_avg_cost;
        const newValue = qtyNum * unitCostNum;
        const newQty = baseQty + qtyNum;
        const newAvgCost = newQty > 0 ? (baseQty * baseCost + newValue) / newQty : 0;

        const { error: purchaseErr } = await supabase
          .from("stock_purchases")
          .update({
            supplier: supplier.trim() || null,
            qty: qtyNum,
            unit_cost: unitCostNum,
            total_cost: qtyNum * unitCostNum,
            new_avg_cost: newAvgCost,
            expiry_date: expiryDate || null,
            remaining_qty: qtyNum,
          })
          .eq("id", editId);
        if (purchaseErr) throw purchaseErr;

        await upsertStoreInventory(storeId, selectedProduct.id, {
          stock_qty: newQty,
          avg_cost: newAvgCost,
          last_purchase_cost: unitCostNum,
        });

        showToast(`✅ ${t("stockIn_editTitle")} — ${fmt(newAvgCost)}`);
      } else {
        const existingValue = selectedProduct.stock_qty * selectedProduct.avg_cost;
        const newValue = qtyNum * unitCostNum;
        const newQty = selectedProduct.stock_qty + qtyNum;
        const newAvgCost = newQty > 0 ? (existingValue + newValue) / newQty : 0;

        const { error: purchaseErr } = await supabase.from("stock_purchases").insert({
          product_id: selectedProduct.id,
          store_id: storeId,
          supplier: supplier.trim() || null,
          qty: qtyNum,
          unit_cost: unitCostNum,
          total_cost: qtyNum * unitCostNum,
          new_avg_cost: newAvgCost,
          expiry_date: expiryDate || null,
          remaining_qty: qtyNum,
        });
        if (purchaseErr) throw purchaseErr;

        await upsertStoreInventory(storeId, selectedProduct.id, {
          stock_qty: newQty,
          avg_cost: newAvgCost,
          previous_avg_cost: selectedProduct.avg_cost,
          last_purchase_cost: unitCostNum,
        });

        showToast(`${t("stockIn_success")} ${fmt(newAvgCost)}`);
      }

      setShowForm(false);
      setEditId(null);
      await loadProducts();
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(row: PurchaseRow) {
    if (!confirm(t("stockIn_deleteConfirm"))) return;
    setPendingAction({ type: "delete", row });
    setPwInput("");
    setPwError("");
  }

  function requestEdit(row: PurchaseRow) {
    setPendingAction({ type: "edit", row });
    setPwInput("");
    setPwError("");
  }

  async function confirmPassword() {
    if (!profile || !pendingAction) return;
    setPwLoading(true);
    setPwError("");
    const { error } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: pwInput,
    });
    setPwLoading(false);
    if (error) {
      setPwError(t("stockIn_passwordWrong"));
      return;
    }

    if (pendingAction.type === "edit") {
      openEdit(pendingAction.row);
    } else {
      await performDelete(pendingAction.row);
    }
    setPendingAction(null);
  }

  async function performDelete(row: PurchaseRow) {
    const product = products.find((p) => p.id === row.product_id);
    if (!product) return;
    try {
      const revertedQty = product.stock_qty - row.qty;
      const revertedAvgCost = product.previous_avg_cost;

      await upsertStoreInventory(storeId, product.id, {
        stock_qty: revertedQty,
        avg_cost: revertedAvgCost,
      });

      const { error: deleteErr } = await supabase.from("stock_purchases").delete().eq("id", row.id);
      if (deleteErr) throw deleteErr;

      showToast("🗑️ Stock-in ဖျက်ပြီးပါပြီ, cost/stock ပြန်ပြင်ပြီးပါပြီ");
      await loadProducts();
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    }
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("stockIn_historyTitle")}</h2>
        <button
          onClick={openNew}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
        >
          {t("stockIn_addNew")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_supplier")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_qtyColumn")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_unitCost")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_newAvgCost")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_expiryDate")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_remaining")}</th>
              <th className="text-right px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => {
              const isLatest = latestByProduct.get(h.product_id) === h.id;
              const isExpired = h.expiry_date && new Date(h.expiry_date) < new Date();
              const isExpiringSoon =
                h.expiry_date &&
                !isExpired &&
                new Date(h.expiry_date).getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000;
              return (
                <tr key={h.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(h.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{h.products?.name || "-"}</td>
                  <td className="px-3 py-2 text-slate-400">{h.supplier || "-"}</td>
                  <td className="px-3 py-2">{h.qty}</td>
                  <td className="px-3 py-2">{fmt(h.unit_cost)}</td>
                  <td className="px-3 py-2 font-medium">{fmt(h.new_avg_cost)}</td>
                  <td
                    className={`px-3 py-2 ${
                      isExpired ? "text-red-600 font-semibold" : isExpiringSoon ? "text-orange-600 font-medium" : ""
                    }`}
                  >
                    {h.expiry_date ? h.expiry_date : "-"}
                    {isExpired && " ⚠️"}
                  </td>
                  <td className="px-3 py-2">{h.remaining_qty}</td>
                  <td className="px-3 py-2 text-right space-x-2">
                    {isLatest ? (
                      <>
                        <button onClick={() => requestEdit(h)} className="text-blue-600 text-xs font-medium">
                          {t("stockIn_edit")}
                        </button>
                        <button onClick={() => requestDelete(h)} className="text-red-600 text-xs font-medium">
                          {t("stockIn_delete")}
                        </button>
                      </>
                    ) : (
                      <span className="text-slate-300 text-xs" title={t("stockIn_onlyLatestEditable")}>
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {history.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-slate-400 py-8">
                  {t("stockIn_historyEmpty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New / Edit Stock-In modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg"
          >
            <h3 className="font-semibold text-lg mb-4">
              {editId ? t("stockIn_editTitle") : t("stockIn_title")}
            </h3>

            <label className="text-sm text-slate-600">{t("stockIn_product")}</label>
            <div className="relative mt-1 mb-3">
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder={t("stockIn_searchPlaceholder")}
                value={productSearch}
                disabled={!!editId}
                onChange={(e) => {
                  const value = e.target.value;
                  setProductSearch(value);
                  setProductId("");
                  setShowDropdown(true);

                  // Barcode scanner types the full code then usually adds nothing else —
                  // auto-select as soon as it exactly matches a product's SKU.
                  const exactSkuMatch = products.find(
                    (p) => (p.sku || "").toLowerCase() === value.trim().toLowerCase() && value.trim() !== ""
                  );
                  if (exactSkuMatch) {
                    setProductId(exactSkuMatch.id);
                    setProductSearch(exactSkuMatch.name);
                    setShowDropdown(false);
                  }
                }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              />
              {showDropdown && !editId && filteredProducts.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredProducts.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => {
                        setProductId(p.id);
                        setProductSearch(p.name);
                        setShowDropdown(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                    >
                      {p.name}{" "}
                      <span className="text-slate-400">
                        [{p.sku}] ({p.stock_qty} @ {p.avg_cost.toLocaleString()})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="text-sm text-slate-600">{t("stockIn_supplier")}</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />

            <label className="text-sm text-slate-600">{t("stockIn_qty")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              required
            />

            <label className="text-sm text-slate-600">{t("stockIn_unitCost")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              required
            />

            <label className="text-sm text-slate-600">{t("stockIn_expiryDate")}</label>
            <input
              type="date"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />

            {previewAvgCost !== null && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs mb-3">
                <div className="flex justify-between font-semibold text-blue-700">
                  <span>{t("stockIn_newAvgCost")}</span>
                  <span>{fmt(previewAvgCost)}</span>
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
                {saving ? t("stockIn_processing") : t("stockIn_submit")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Password confirmation modal */}
      {pendingAction && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("stockIn_passwordTitle")}</h3>
            <p className="text-sm text-slate-500 mb-4">{t("stockIn_passwordSubtitle")}</p>
            <input
              type="password"
              autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2"
              placeholder={t("stockIn_passwordPlaceholder")}
              value={pwInput}
              onChange={(e) => setPwInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmPassword()}
            />
            {pwError && <p className="text-red-600 text-xs mb-2">{pwError}</p>}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setPendingAction(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("stockIn_passwordCancel")}
              </button>
              <button
                onClick={confirmPassword}
                disabled={pwLoading || !pwInput}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {pwLoading ? "..." : t("stockIn_passwordConfirm")}
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
