"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, SellableItem, fetchSellableItems, fetchSellableItem, upsertStoreInventory , logActivity } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission, isManagerTier, APPROVER_ROLES } from "../permissions";

type RequestRow = {
  id: string;
  product_id: string;
  variant_id: string | null;
  store_id: string;
  requested_qty: number;
  received_qty: number | null;
  note: string | null;
  status: "awaiting_approval" | "pending" | "received" | "mismatch" | "approved" | "rejected" | "cancelled";
  requested_by: string | null;
  received_by: string | null;
  approved_by: string | null;
  created_at: string;
  requested_warehouse_id: string | null;
  request_no: string | null;
  rejected_reason: string | null;
  products: { name: string; sku: string | null } | null;
  product_variants: { variant_name: string; sku: string | null } | null;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

const statusColor: Record<string, string> = {
  awaiting_approval: "bg-yellow-100 text-yellow-700",
  pending: "bg-slate-100 text-slate-600",
  received: "bg-green-100 text-green-700",
  mismatch: "bg-orange-100 text-orange-700",
  approved: "bg-blue-100 text-blue-700",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-400",
};

export default function StockRequestPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [items, setItems] = useState<SellableItem[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [toast, setToast] = useState("");

  const [showNewForm, setShowNewForm] = useState(false);
  const [itemKey, setItemKey] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [requestedQty, setRequestedQty] = useState("");
  const [draftLines, setDraftLines] = useState<{ key: string; qty: number }[]>([]);
  const [note, setNote] = useState("");

  const [approveRow, setApproveRow] = useState<RequestRow | null>(null);
  const [approvalPin, setApprovalPin] = useState("");
  const [verifying, setVerifying] = useState(false);

  const [editRow, setEditRow] = useState<RequestRow | null>(null);
  const [editQty, setEditQty] = useState("");

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

  const supplyWarehouseId = stores.find((s) => s.id === storeId)?.supply_warehouse_id || null;
  const supplyWarehouse = stores.find((s) => s.id === supplyWarehouseId);
  const canApproveRequest =
    isManagerTier(profile.role) ||
    profile.role === "owner" || profile.role === "admin";

  async function loadProducts() {
    const data = await fetchSellableItems(storeId);
    setItems(data);
  }

  async function loadRequests() {
    const { data } = await supabase
      .from("stock_requests")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    setRequests((data as unknown as RequestRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  // Only before a sale manager has seen it. Cancelling keeps the row so the
  // request still shows in history; deleting would lose the audit trail.
  async function cancelRequest(r: RequestRow) {
    if (r.status !== "awaiting_approval") return;
    if (!confirm(t("stockRequest_cancelConfirm"))) return;
    const { error } = await supabase
      .from("stock_requests")
      .update({ status: "cancelled" })
      .eq("id", r.id)
      .eq("status", "awaiting_approval");
    if (error) return showToast("\u274c " + error.message);
    await logActivity({
      entityType: "stock_request",
      entityId: r.id,
      action: "cancelled",
      detail: `${r.request_no || r.id} \u00b7 ${r.store_id}`,
    });
    showToast(t("stockRequest_cancelled"));
    await loadRequests();
  }

  // Editable until the warehouse acts. Changing an approved quantity sends it
  // back for approval - otherwise a cashier could raise 10, get a yes, then
  // quietly change it to 100.
  async function saveEdit() {
    if (!editRow) return;
    const qty = Number(editQty);
    if (!qty || qty <= 0) return showToast(t("stockRequest_invalidQty"));

    const { error } = await supabase
      .from("stock_requests")
      .update({
        requested_qty: qty,
        status: "awaiting_approval",
        approved_by: null,
        approved_at: null,
      })
      .eq("id", editRow.id)
      .in("status", ["awaiting_approval", "pending"]);
    if (error) return showToast("\u274c " + error.message);

    await logActivity({
      entityType: "stock_request",
      entityId: editRow.id,
      action: "edited",
      detail: `${editRow.request_no || editRow.id} \u00b7 ${editRow.requested_qty} \u2192 ${qty}`,
    });

    setEditRow(null);
    setEditQty("");
    showToast(t("stockRequest_editedNeedsApproval"));
    await loadRequests();
  }

  async function approveRequest(approver?: string) {
    if (!approveRow) return;
    const { error } = await supabase
      .from("stock_requests")
      .update({ status: "pending", approved_by: approver || profile?.email || null })
      .eq("id", approveRow.id);
    if (error) return showToast("❌ " + error.message);
    showToast(t("stockRequest_approvedSent"));
    setApproveRow(null);
    setApprovalPin("");
    await loadRequests();
  }

  async function approveWithPin() {
    if (!approvalPin.trim()) return showToast(t("returns_pinRequired"));
    setVerifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-discount-approver", {
        body: { pin: approvalPin.trim() },
      });
      if (error) throw error;
      if (!data?.approved) return showToast("❌ " + (data?.error || t("returns_pinInvalid")));
      await approveRequest(data.approver_email);
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setVerifying(false);
    }
  }

  function addDraftLine() {
    const item = items.find((i) => i.key === itemKey);
    const qty = Number(requestedQty);
    if (!item || !qty || qty <= 0) return showToast(t("stockRequest_qtyInvalid"));
    setDraftLines((prev) =>
      prev.find((l) => l.key === item.key)
        ? prev.map((l) => (l.key === item.key ? { ...l, qty: l.qty + qty } : l))
        : [...prev, { key: item.key, qty }]
    );
    setItemKey("");
    setRequestedQty("");
    setBarcodeInput("");
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    // Anything still typed into the picker counts as a line, so the user does not
    // have to press "add" before submitting a single-item request
    const pending = items.find((i) => i.key === itemKey);
    const pendingQty = Number(requestedQty);
    const lines = [...draftLines];
    if (pending && pendingQty > 0 && !lines.find((l) => l.key === pending.key)) {
      lines.push({ key: pending.key, qty: pendingQty });
    }
    if (!lines.length) return showToast(t("stockRequest_noLines"));

    // One request number ties the lines together, the way a PO does
    const requestNo = `SR-${Date.now().toString().slice(-8)}`;
    const rows = lines
      .map((l) => {
        const it = items.find((i) => i.key === l.key);
        if (!it) return null;
        return {
          store_id: storeId,
          product_id: it.product_id,
          variant_id: it.variant_id,
          requested_warehouse_id: supplyWarehouseId,
          request_no: requestNo,
          status: canApproveRequest ? "pending" : "awaiting_approval",
          requested_qty: l.qty,
          note: note.trim() || null,
          requested_by: profile?.email || null,
        };
      })
      .filter(Boolean);

    const { error } = await supabase.from("stock_requests").insert(rows as any[]);
    if (error) {
      showToast("❌ " + error.message);
      return;
    }
    showToast(t("stockRequest_created"));
    setShowNewForm(false);
    setItemKey("");
    setRequestedQty("");
    setNote("");
    setDraftLines([]);
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
                <td className="px-3 py-2">
                  {new Date(r.created_at).toLocaleString()}
                  {r.request_no && (
                    <div className="text-[10px] text-slate-400 font-mono">{r.request_no}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.products?.name || "-"}
                  {r.product_variants?.variant_name && (
                    <span className="text-blue-600 text-xs ml-1">({r.product_variants.variant_name})</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-400 text-xs">
                  {r.product_variants?.sku || r.products?.sku || "-"}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">
                  {stores.find((st) => st.id === r.requested_warehouse_id)?.name ||
                    (r.requested_warehouse_id ? r.requested_warehouse_id : "-")}
                </td>
                <td className="px-3 py-2">{r.requested_qty}</td>
                <td className="px-3 py-2">{r.received_qty ?? "-"}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status]}`}>
                    {t(`stockRequest_status_${r.status}` as any)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {r.status === "awaiting_approval" && (
                    <div className="flex gap-2 justify-end items-center">
                      <button onClick={() => { setApproveRow(r); setApprovalPin(""); }}
                        className="text-blue-600 text-xs font-medium">
                        {t("stockRequest_needsApproval")}
                      </button>
                      <button onClick={() => { setEditRow(r); setEditQty(String(r.requested_qty)); }}
                        className="text-slate-500 text-xs font-medium">
                        {t("stockRequest_edit")}
                      </button>
                      <button onClick={() => cancelRequest(r)}
                        className="text-red-600 text-xs font-medium">
                        {t("stockRequest_cancel")}
                      </button>
                    </div>
                  )}
                  {r.status === "pending" && (
                    <div className="flex gap-2 justify-end items-center">
                      <span className="text-xs text-slate-400">{t("stockRequest_awaitingWarehouse")}</span>
                      <button onClick={() => { setEditRow(r); setEditQty(String(r.requested_qty)); }}
                        className="text-slate-500 text-xs font-medium">
                        {t("stockRequest_edit")}
                      </button>
                    </div>
                  )}
                  {r.status === "approved" && (
                    <Link href="/incoming-transfers" className="text-blue-600 text-xs font-medium">
                      {t("stockRequest_confirmInTransfers")}
                    </Link>
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

      {/* Edit quantity */}
      {editRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("stockRequest_edit")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {editRow.products?.name}
              {editRow.product_variants?.variant_name && ` (${editRow.product_variants.variant_name})`}
            </p>

            <label className="text-sm text-slate-600">{t("stockRequest_qty")}</label>
            <input
              autoFocus
              type="number"
              min={1}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={editQty}
              onChange={(e) => setEditQty(e.target.value)}
            />

            {editRow.status === "pending" && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                {t("stockRequest_editResetsApproval")}
              </p>
            )}

            <div className="flex gap-2">
              <button onClick={() => setEditRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm">
                {t("returns_cancel")}
              </button>
              <button onClick={saveEdit}
                className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold">
                {t("stockRequest_save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New request modal */}
      {showNewForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitRequest} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("stockRequest_new")}</h3>

            <label className="text-sm text-slate-600">{t("po_scanBarcode")}</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
            placeholder={t("po_scanBarcodePlaceholder")}
            value={barcodeInput}
            onChange={(e) => {
              const v = e.target.value;
              setBarcodeInput(v);
              // Scanners type the whole code then stop, so match on an exact SKU
              const hit = items.find(
                (i) => (i.sku || "").toLowerCase() === v.trim().toLowerCase() && v.trim() !== ""
              );
              if (hit) {
                setItemKey(hit.key);
                setBarcodeInput("");
              }
            }}
          />

          <label className="text-sm text-slate-600">{t("stockIn_product")}</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={itemKey}
              onChange={(e) => setItemKey(e.target.value)}
            >
              <option value="">{t("stockIn_selectPlaceholder")}</option>
              {items.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.display_name}{i.sku ? ` · ${i.sku}` : ""} ({t("barcode_balanceStock")}: {i.stock_qty})
                </option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("stockRequest_requestedQty")}</label>
            <input
              type="number"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={requestedQty}
              onChange={(e) => setRequestedQty(e.target.value)}
            />

            <button type="button" onClick={addDraftLine}
              className="w-full py-2 border border-slate-300 rounded-lg text-sm font-medium mb-3">
              + {t("stockRequest_addLine")}
            </button>

            {draftLines.length > 0 && (
              <div className="border border-slate-200 rounded-lg p-2 mb-3 space-y-1">
                {draftLines.map((l) => {
                  const it = items.find((i) => i.key === l.key);
                  if (!it) return null;
                  return (
                    <div key={l.key} className="flex items-center gap-2 text-sm bg-slate-50 rounded px-2 py-1.5">
                      <span className="flex-1 min-w-0 truncate">
                        {it.display_name}
                        {it.sku && <span className="text-slate-400 text-xs"> · {it.sku}</span>}
                      </span>
                      <input type="number" min={1}
                        className="w-16 border border-slate-200 rounded px-2 py-1 text-sm"
                        value={l.qty}
                        onChange={(e) =>
                          setDraftLines((prev) =>
                            prev.map((x) => (x.key === l.key ? { ...x, qty: Number(e.target.value) } : x))
                          )
                        } />
                      <button type="button" className="text-red-500"
                        onClick={() => setDraftLines((prev) => prev.filter((x) => x.key !== l.key))}>
                        ✕
                      </button>
                    </div>
                  );
                })}
                <div className="text-xs text-slate-500 px-2 pt-1">
                  {t("po_items")}: {draftLines.length}
                </div>
              </div>
            )}

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

      {approveRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("stockRequest_approveTitle")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {approveRow.products?.name} · {t("stockRequest_requestedQty")}: {approveRow.requested_qty}
            </p>

            {canApproveRequest ? (
              <div className="flex gap-2">
                <button onClick={() => setApproveRow(null)}
                  className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                  {t("products_cancel")}
                </button>
                <button onClick={() => approveRequest()}
                  className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold">
                  {t("returns_approve")}
                </button>
              </div>
            ) : (
              <>
                <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-3">
                  {t("returns_pinHint")}
                </p>
                <input type="password" inputMode="numeric" autoFocus
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3 tracking-widest text-center"
                  placeholder="••••"
                  value={approvalPin} onChange={(e) => setApprovalPin(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && approveWithPin()} />
                <div className="flex gap-2">
                  <button onClick={() => setApproveRow(null)}
                    className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                    {t("products_cancel")}
                  </button>
                  <button onClick={approveWithPin} disabled={verifying}
                    className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                    {verifying ? "..." : t("returns_approveWithPin")}
                  </button>
                </div>
              </>
            )}
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
