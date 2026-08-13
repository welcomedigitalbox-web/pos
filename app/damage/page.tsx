"use client";

import { useEffect, useState } from "react";
import { supabase, Product, fetchProductsWithStock, upsertStoreInventory } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type DamageRow = {
  id: string;
  qty: number;
  reason: string | null;
  reported_by: string | null;
  created_at: string;
  products: { name: string } | null;
};

export default function DamagePage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [history, setHistory] = useState<DamageRow[]>([]);
  const [toast, setToast] = useState("");

  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "damage")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadProducts();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "damage")) return null;

  async function loadProducts() {
    const data = await fetchProductsWithStock(storeId);
    setProducts(data);
  }

  async function loadHistory() {
    const { data } = await supabase
      .from("stock_damages")
      .select("*, products(name)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    setHistory((data as unknown as DamageRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function submitDamage(e: React.FormEvent) {
    e.preventDefault();
    const product = products.find((p) => p.id === productId);
    const qtyNum = Number(qty);
    if (!product) return showToast(t("stockIn_selectProduct"));
    if (!qtyNum || qtyNum <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (qtyNum > product.stock_qty) return showToast(t("damage_notEnoughStock"));

    setSaving(true);
    try {
      const { error: insertErr } = await supabase.from("stock_damages").insert({
        store_id: storeId,
        product_id: productId,
        qty: qtyNum,
        reason: reason.trim() || null,
        reported_by: profile?.email || null,
      });
      if (insertErr) throw insertErr;

      const newStock = product.stock_qty - qtyNum;
      await upsertStoreInventory(storeId, productId, { stock_qty: newStock });

      // FEFO deduction from batches (keep batch tracking consistent)
      const { data: batches } = await supabase
        .from("stock_purchases")
        .select("id, remaining_qty")
        .eq("product_id", productId)
        .eq("store_id", storeId)
        .gt("remaining_qty", 0)
        .order("expiry_date", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });

      let remainingToDeduct = qtyNum;
      for (const batch of batches || []) {
        if (remainingToDeduct <= 0) break;
        const deductFromBatch = Math.min(batch.remaining_qty, remainingToDeduct);
        await supabase
          .from("stock_purchases")
          .update({ remaining_qty: batch.remaining_qty - deductFromBatch })
          .eq("id", batch.id);
        remainingToDeduct -= deductFromBatch;
      }

      showToast(t("damage_recorded"));
      setProductId("");
      setQty("");
      setReason("");
      await loadProducts();
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit">
        <h2 className="font-semibold mb-3">{t("nav_damage")}</h2>
        <form onSubmit={submitDamage}>
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
                {p.name} ({t("barcode_balanceStock")}: {p.stock_qty})
              </option>
            ))}
          </select>

          <label className="text-sm text-slate-600">{t("damage_qty")}</label>
          <input
            type="number"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />

          <label className="text-sm text-slate-600">{t("damage_reason")}</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("damage_reasonPlaceholder")}
          />

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 bg-red-600 disabled:bg-slate-300 text-white rounded-lg font-semibold text-sm"
          >
            {saving ? t("stockIn_processing") : t("damage_submit")}
          </button>
        </form>
      </div>

      <div>
        <h3 className="font-semibold mb-2">{t("damage_history")}</h3>
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[500px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("history_time")}</th>
                <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                <th className="text-left px-3 py-2">{t("damage_qty")}</th>
                <th className="text-left px-3 py-2">{t("damage_reason")}</th>
                <th className="text-left px-3 py-2">{t("saleOrder_myOrders")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(h.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{h.products?.name || "-"}</td>
                  <td className="px-3 py-2 text-red-600 font-medium">-{h.qty}</td>
                  <td className="px-3 py-2 text-slate-400">{h.reason || "-"}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{h.reported_by || "-"}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-8">
                    -
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
