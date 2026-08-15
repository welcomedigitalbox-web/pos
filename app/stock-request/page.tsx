"use client";

import { useEffect, useState } from "react";
import { supabase, SellableItem, fetchSellableItems, fetchSellableItem, upsertStoreInventory } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type RequestRow = {
  id: string;
  product_id: string;
  variant_id: string | null;
  requested_qty: number;
  received_qty: number | null;
  note: string | null;
  status: "pending" | "received" | "mismatch" | "approved" | "rejected";
  requested_by: string | null;
  received_by: string | null;
  approved_by: string | null;
  created_at: string;
  products: { name: string } | null;
  product_variants: { variant_name: string } | null;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

const statusColor: Record<string, string> = {
  pending: "bg-slate-100 text-slate-600",
  received: "bg-green-100 text-green-700",
  mismatch: "bg-orange-100 text-orange-700",
  approved: "bg-blue-100 text-blue-700",
  rejected: "bg-red-100 text-red-700",
};

export default function StockRequestPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [items, setItems] = useState<SellableItem[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [toast, setToast] = useState("");

  const [showNewForm, setShowNewForm] = useState(false);
  const [itemKey, setItemKey] = useState("");
  const [requestedQty, setRequestedQty] = useState("");
  const [note, setNote] = useState("");

  const [receivingId, setReceivingId] = useState<string | null>(null);
  const [receivedQty, setReceivedQty] = useState("");
  const [unitCost, setUnitCost] = useState("");

  const canApprove = hasPermission(profile, "stock-in"); // manager-tier

  useEffect(() => {
    if (profile && !hasPermission(profile, "stock-request")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadProducts();
    loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "stock-request")) return null;

  async function loadProducts() {
    const data = await fetchSellableItems(storeId);
    setItems(data);
  }

  async function loadRequests() {
    const { data } = await supabase
      .from("stock_requests")
      .select("*, products(name), product_variants(variant_name)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    setRequests((data as unknown as RequestRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    const item = items.find((i) => i.key === itemKey);
    if (!item || !requestedQty) return;
    const { error } = await supabase.from("stock_requests").insert({
      store_id: storeId,
      product_id: item.product_id,
      variant_id: item.variant_id,
      requested_qty: Number(requestedQty),
      note: note.trim() || null,
      requested_by: profile?.email || null,
    });
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("stockRequest_created"));
    setShowNewForm(false);
    setItemKey("");
    setRequestedQty("");
    setNote("");
    await loadRequests();
  }

  function openReceive(r: RequestRow) {
    setReceivingId(r.id);
    setReceivedQty(String(r.requested_qty));
    setUnitCost("");
  }

  async function submitReceive(r: RequestRow) {
    const qty = Number(receivedQty);
    const cost = Number(unitCost);
    if (!qty || qty <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (isNaN(cost) || cost < 0) return showToast(t("stockIn_costInvalid"));

    try {
      // Moving average update (same logic as Stock-In)
      const fullProduct = await fetchSellableItem(r.product_id, r.variant_id, storeId);
      if (!fullProduct) throw new Error("Product not found");

      const existingValue = fullProduct.stock_qty * fullProduct.avg_cost;
      const newValue = qty * cost;
      const newQty = fullProduct.stock_qty + qty;
      const newAvgCost = newQty > 0 ? (existingValue + newValue) / newQty : 0;

      const { data: batch, error: batchErr } = await supabase
        .from("stock_purchases")
        .insert({
          product_id: r.product_id,
          variant_id: r.variant_id,
          store_id: storeId,
          supplier: null,
          qty,
          unit_cost: cost,
          total_cost: qty * cost,
          new_avg_cost: newAvgCost,
          remaining_qty: qty,
          stock_request_id: r.id,
        })
        .select()
        .single();
      if (batchErr) throw batchErr;

      await upsertStoreInventory(storeId, r.product_id, r.variant_id, {
        stock_qty: newQty,
        avg_cost: newAvgCost,
        previous_avg_cost: fullProduct.avg_cost,
        last_purchase_cost: cost,
      });

      const matched = qty === r.requested_qty;
      await supabase
        .from("stock_requests")
        .update({
          received_qty: qty,
          status: matched ? "received" : "mismatch",
          received_by: profile?.email || null,
          received_at: new Date().toISOString(),
        })
        .eq("id", r.id);

      showToast(matched ? t("stockRequest_receivedMatched") : t("stockRequest_receivedMismatch"));
      setReceivingId(null);
      await loadRequests();
      await loadProducts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("❌ " + message);
    }
  }

  async function approveMismatch(id: string) {
    await supabase
      .from("stock_requests")
      .update({ status: "approved", approved_by: profile?.email || null, approved_at: new Date().toISOString() })
      .eq("id", id);
    showToast(t("stockRequest_approved"));
    await loadRequests();
  }

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("nav_stockRequest")}</h2>
        <button
          onClick={() => setShowNewForm(true)}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium"
        >
          {t("stockRequest_new")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[750px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
              <th className="text-left px-3 py-2">{t("stockRequest_requestedQty")}</th>
              <th className="text-left px-3 py-2">{t("stockRequest_receivedQty")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {r.products?.name || "-"}
                  {r.product_variants?.variant_name && (
                    <span className="text-blue-600 text-xs ml-1">({r.product_variants.variant_name})</span>
                  )}
                </td>
                <td className="px-3 py-2">{r.requested_qty}</td>
                <td className="px-3 py-2">{r.received_qty ?? "-"}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status]}`}>
                    {t(`stockRequest_status_${r.status}` as any)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {r.status === "pending" && (
                    <button onClick={() => openReceive(r)} className="text-blue-600 text-xs font-medium">
                      {t("stockRequest_receive")}
                    </button>
                  )}
                  {r.status === "mismatch" && canApprove && (
                    <button onClick={() => approveMismatch(r.id)} className="text-orange-600 text-xs font-medium">
                      {t("stockRequest_approve")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New request modal */}
      {showNewForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitRequest} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("stockRequest_new")}</h3>

            <label className="text-sm text-slate-600">{t("stockIn_product")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={itemKey}
              onChange={(e) => setItemKey(e.target.value)}
              required
            >
              <option value="">{t("stockIn_selectPlaceholder")}</option>
              {items.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.display_name} ({t("barcode_balanceStock")}: {i.stock_qty})
                </option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("stockRequest_requestedQty")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={requestedQty}
              onChange={(e) => setRequestedQty(e.target.value)}
              required
            />

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <textarea
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowNewForm(false)}
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

      {/* Receive modal */}
      {receivingId && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("stockRequest_receive")}</h3>
            <p className="text-xs text-slate-400 mb-4">{t("stockRequest_receiveHint")}</p>

            <label className="text-sm text-slate-600">{t("stockRequest_receivedQty")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={receivedQty}
              onChange={(e) => setReceivedQty(e.target.value)}
              required
            />

            <label className="text-sm text-slate-600">{t("stockIn_unitCost")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              required
            />

            <div className="flex gap-2">
              <button
                onClick={() => setReceivingId(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                {t("products_cancel")}
              </button>
              <button
                onClick={() => {
                  const r = requests.find((rq) => rq.id === receivingId);
                  if (r) submitReceive(r);
                }}
                className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold"
              >
                {t("products_save")}
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
