"use client";

import { useEffect, useState } from "react";
import { supabase, Product } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function StockInPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [history, setHistory] = useState<
    { id: string; created_at: string; supplier: string | null; qty: number; unit_cost: number; total_cost: number; new_avg_cost: number; products: { name: string } | null }[]
  >([]);

  const [productId, setProductId] = useState("");
  const [supplier, setSupplier] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && profile.role === "cashier") {
      router.replace("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadProducts();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || profile.role === "cashier") return null;

  async function loadProducts() {
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("store_id", storeId)
      .order("name");
    setProducts(data || []);
  }

  async function loadHistory() {
    const { data } = await supabase
      .from("stock_purchases")
      .select("*, products(name)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(30);
    setHistory((data as any) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  const selectedProduct = products.find((p) => p.id === productId);
  const qtyNum = Number(qty) || 0;
  const unitCostNum = Number(unitCost) || 0;

  // Live preview of new moving average cost
  let previewAvgCost: number | null = null;
  if (selectedProduct && qtyNum > 0 && unitCostNum >= 0) {
    const existingValue = selectedProduct.stock_qty * selectedProduct.avg_cost;
    const newValue = qtyNum * unitCostNum;
    previewAvgCost = (existingValue + newValue) / (selectedProduct.stock_qty + qtyNum);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProduct) return showToast("Product ရွေးပါ");
    if (qtyNum <= 0) return showToast("Qty ကို 0 ထက်ကြီးရပါမယ်");
    if (unitCostNum < 0) return showToast("Unit cost မှားနေပါတယ်");

    setSaving(true);
    try {
      // Moving Weighted Average calculation
      const existingValue = selectedProduct.stock_qty * selectedProduct.avg_cost;
      const newValue = qtyNum * unitCostNum;
      const newQty = selectedProduct.stock_qty + qtyNum;
      const newAvgCost = newQty > 0 ? (existingValue + newValue) / newQty : 0;

      // 1. Record the purchase (audit trail)
      const { error: purchaseErr } = await supabase.from("stock_purchases").insert({
        product_id: selectedProduct.id,
        store_id: storeId,
        supplier: supplier.trim() || null,
        qty: qtyNum,
        unit_cost: unitCostNum,
        total_cost: qtyNum * unitCostNum,
        new_avg_cost: newAvgCost,
      });
      if (purchaseErr) throw purchaseErr;

      // 2. Update product: stock_qty += qty, avg_cost = newAvgCost, last_purchase_cost = unitCost
      const { error: updateErr } = await supabase
        .from("products")
        .update({
          stock_qty: newQty,
          avg_cost: newAvgCost,
          last_purchase_cost: unitCostNum,
          updated_at: new Date().toISOString(),
        })
        .eq("id", selectedProduct.id);
      if (updateErr) throw updateErr;

      showToast(`✅ Stock-in success! New avg cost: ${fmt(newAvgCost)}`);
      setProductId("");
      setSupplier("");
      setQty("");
      setUnitCost("");
      await loadProducts();
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ Error: " + message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
      {/* Stock-in form */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit">
        <h2 className="font-semibold mb-3">Stock-In (Purchase Receiving)</h2>
        <form onSubmit={handleSubmit}>
          <label className="text-sm text-slate-600">Product</label>
          <select
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            required
          >
            <option value="">-- ရွေးပါ --</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (stock: {p.stock_qty}, avg cost: {p.avg_cost.toLocaleString()})
              </option>
            ))}
          </select>

          <label className="text-sm text-slate-600">Supplier (optional)</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
          />

          <label className="text-sm text-slate-600">Purchase Qty</label>
          <input
            type="number"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />

          <label className="text-sm text-slate-600">Unit Cost (MMK)</label>
          <input
            type="number"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            required
          />

          {previewAvgCost !== null && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs mb-3">
              <div className="flex justify-between">
                <span>လက်ရှိ Stock/Avg Cost</span>
                <span>
                  {selectedProduct!.stock_qty} @ {fmt(selectedProduct!.avg_cost)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>ဝယ်မယ့် Qty/Cost</span>
                <span>
                  {qtyNum} @ {fmt(unitCostNum)}
                </span>
              </div>
              <div className="flex justify-between font-semibold text-blue-700 border-t border-blue-200 mt-1 pt-1">
                <span>New Avg Cost</span>
                <span>{fmt(previewAvgCost)}</span>
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg font-semibold text-sm"
          >
            {saving ? "Processing..." : "Stock-In ထည့်မယ်"}
          </button>
        </form>
      </div>

      {/* Purchase history */}
      <div>
        <h2 className="font-semibold mb-3">Stock-In History</h2>
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Product</th>
                <th className="text-left px-3 py-2">Supplier</th>
                <th className="text-left px-3 py-2">Qty</th>
                <th className="text-left px-3 py-2">Unit Cost</th>
                <th className="text-left px-3 py-2">New Avg Cost</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(h.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{h.products?.name || "-"}</td>
                  <td className="px-3 py-2 text-slate-400">{h.supplier || "-"}</td>
                  <td className="px-3 py-2">{h.qty}</td>
                  <td className="px-3 py-2">{fmt(h.unit_cost)}</td>
                  <td className="px-3 py-2 font-medium">{fmt(h.new_avg_cost)}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-slate-400 py-8">
                    Stock-in history မရှိသေးပါ
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
