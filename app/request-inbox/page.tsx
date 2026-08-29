"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, fetchSellableItems, upsertStoreInventory, logActivity } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type RequestRow = {
  id: string;
  store_id: string;
  product_id: string;
  variant_id: string | null;
  requested_qty: number;
  received_qty: number | null;
  status: string;
  requested_by: string | null;
  note: string | null;
  created_at: string;
  displayName: string;
  sku: string | null;
  availableAtWh: number;
  avgCostAtWh: number;
};

const statusColor: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  received: "bg-green-100 text-green-700",
  mismatch: "bg-orange-100 text-orange-700",
  rejected: "bg-red-100 text-red-700",
};

export default function RequestInboxPage() {
  const { stores, warehouses, defaultWarehouseId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [whId, setWhId] = useState("");
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [toast, setToast] = useState("");

  const [sendRow, setSendRow] = useState<RequestRow | null>(null);
  const [sendQty, setSendQty] = useState("");
  const [sending, setSending] = useState(false);
  const [rejectRow, setRejectRow] = useState<RequestRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "request-inbox")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!whId && defaultWarehouseId) setWhId(defaultWarehouseId);
  }, [defaultWarehouseId, whId]);

  useEffect(() => {
    if (whId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whId]);

  if (!profile || !hasPermission(profile, "request-inbox")) return null;

  async function load() {
    setLoading(true);

    // Only requests from the stores this warehouse is responsible for
    const suppliedStores = stores
      .filter((s) => !s.is_warehouse && (s.supply_warehouse_id === whId || !s.supply_warehouse_id))
      .map((s) => s.id);

    const { data } = await supabase
      .from("stock_requests")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .in("store_id", suppliedStores.length ? suppliedStores : ["__none__"])
      .neq("status", "awaiting_approval")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(200);

    const whItems = await fetchSellableItems(whId, true);
    // Keep the cost alongside the quantity: it is stamped onto the transfer so
    // the receiving store never has to read warehouse rows RLS hides from it.
    const stockMap = new Map(
      whItems.map((i) => [
        `${i.product_id}:${i.variant_id || "base"}`,
        { qty: i.stock_qty, cost: i.avg_cost },
      ])
    );

    setRows(
      ((data as any[]) || []).map((r) => ({
        ...r,
        displayName: r.product_variants?.variant_name
          ? `${r.products?.name} (${r.product_variants.variant_name})`
          : r.products?.name || "-",
        sku: r.product_variants?.sku || r.products?.sku || null,
        availableAtWh: stockMap.get(`${r.product_id}:${r.variant_id || "base"}`)?.qty ?? 0,
        avgCostAtWh: stockMap.get(`${r.product_id}:${r.variant_id || "base"}`)?.cost ?? 0,
      }))
    );
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  function openSend(r: RequestRow) {
    setSendRow(r);
    // Default to what was asked for, capped by what's actually on hand
    setSendQty(String(Math.min(r.requested_qty, r.availableAtWh)));
  }

  async function sendStock() {
    if (!sendRow) return;
    const qty = Number(sendQty);
    if (!qty || qty <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (qty > sendRow.availableAtWh) return showToast(t("warehouseTransfer_notEnough"));

    setSending(true);
    try {
      await upsertStoreInventory(whId, sendRow.product_id, sendRow.variant_id, {
        stock_qty: sendRow.availableAtWh - qty,
      });

      // Goes out as a normal transfer, so the store confirms what actually arrived
      const { data: created, error } = await supabase
        .from("stock_transfers")
        .insert({
          product_id: sendRow.product_id,
          variant_id: sendRow.variant_id,
          from_store_id: whId,
          to_store_id: sendRow.store_id,
          qty,
          status: "in_transit",
          transferred_by: profile?.email || null,
          // Cost travels with the goods; the store cannot read warehouse rows.
          unit_cost: Number(sendRow.avgCostAtWh || 0),
        })
        .select()
        .single();
      if (error) throw error;

      await supabase
        .from("stock_requests")
        .update({ status: "approved", approved_by: profile?.email || null, approved_at: new Date().toISOString() })
        .eq("id", sendRow.id);

      await logActivity({
        entityType: "stock_transfer",
        entityId: created.id,
        action: "sent",
        detail: `${sendRow.displayName} × ${qty} → ${sendRow.store_id} (request)`,
        actor: profile?.email,
      });

      showToast(t("requestInbox_sent"));
      setSendRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSending(false);
    }
  }

  async function submitReject() {
    if (!rejectRow) return;
    if (!rejectReason.trim()) return showToast(t("requestInbox_rejectReasonRequired"));
    await supabase
      .from("stock_requests")
      .update({
        status: "rejected",
        approved_by: profile?.email || null,
        rejected_reason: rejectReason.trim(),
      })
      .eq("id", rejectRow.id);
    await logActivity({
      entityType: "stock_request",
      entityId: rejectRow.id,
      action: "rejected",
      detail: `${rejectRow.displayName} → ${rejectRow.store_id} · ${rejectReason.trim()}`,
      actor: profile?.email,
    });
    showToast(t("requestInbox_rejected"));
    setRejectRow(null);
    setRejectReason("");
    await load();
  }

  const visible = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter]
  );
  const pendingCount = rows.filter((r) => r.status === "pending").length;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_requestInbox")}</h2>
      <p className="text-sm text-slate-500 mb-4">
        {t("requestInbox_subtitle")} · {t("returns_pending")}:{" "}
        <span className="font-semibold text-orange-600">{pendingCount}</span>
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {warehouses.length > 1 && (
          <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={whId} onChange={(e) => setWhId(e.target.value)}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>🏭 {w.name}</option>)}
          </select>
        )}
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="pending">{t("returns_status_pending")}</option>
          <option value="all">{t("warehouse_allStock")}</option>
          <option value="approved">{t("requestInbox_sentStatus")}</option>
          <option value="rejected">{t("returns_status_rejected")}</option>
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[880px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("requestInbox_fromStore")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("stockRequest_requestedQty")}</th>
              <th className="text-left px-3 py-2">{t("requestInbox_whStock")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2">{t("returns_requestedBy")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && visible.map((r) => {
              const short = r.availableAtWh < r.requested_qty;
              return (
                <tr key={r.id} className={`border-t border-slate-100 ${r.status === "pending" ? "bg-yellow-50" : ""}`}>
                  <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 font-medium">{r.store_id}</td>
                  <td className="px-3 py-2">{r.displayName}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{r.sku || "-"}</td>
                  <td className="px-3 py-2 font-medium">{r.requested_qty}</td>
                  <td className={`px-3 py-2 ${short ? "text-red-600 font-medium" : ""}`}>
                    {r.availableAtWh}
                    {short && ` ⚠️`}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status] || ""}`}>
                      {r.status === "approved" ? t("requestInbox_sentStatus") : r.status}
                    </span>
                    {(r as any).rejected_reason && (
                      <div className="text-[10px] text-red-600 mt-0.5">{(r as any).rejected_reason}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{r.requested_by || "-"}</td>
                  <td className="px-3 py-2 text-right space-x-3">
                    {r.status === "pending" && (
                      <>
                        <button onClick={() => openSend(r)} disabled={r.availableAtWh <= 0}
                          className="text-blue-600 text-xs font-medium disabled:text-slate-300">
                          {t("requestInbox_send")}
                        </button>
                        <button onClick={() => { setRejectRow(r); setRejectReason(""); }} className="text-red-600 text-xs font-medium">
                          {t("returns_reject")}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {sendRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("requestInbox_send")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {sendRow.displayName} → {sendRow.store_id}
              <br />
              {t("stockRequest_requestedQty")}: {sendRow.requested_qty} · {t("requestInbox_whStock")}: {sendRow.availableAtWh}
            </p>

            {sendRow.availableAtWh < sendRow.requested_qty && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-xs text-orange-700 mb-3">
                ⚠️ {t("requestInbox_shortWarning")}
              </div>
            )}

            <label className="text-sm text-slate-600">{t("warehouseTransfer_qty")}</label>
            <input type="number" autoFocus max={sendRow.availableAtWh}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={sendQty} onChange={(e) => setSendQty(e.target.value)} />

            <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-4">
              {t("requestInbox_sendHint")}
            </p>

            <div className="flex gap-2">
              <button onClick={() => setSendRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={sendStock} disabled={sending}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {sending ? "..." : t("requestInbox_send")}
              </button>
            </div>
          </div>
        </div>
      )}

      {rejectRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("returns_reject")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {rejectRow.displayName} → {rejectRow.store_id}
            </p>
            <label className="text-sm text-slate-600">
              {t("returns_rejectReason")} <span className="text-red-600">*</span>
            </label>
            <textarea rows={3} autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              placeholder={t("requestInbox_rejectPlaceholder")}
              value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <div className="flex gap-2">
              <button onClick={() => setRejectRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitReject} disabled={!rejectReason.trim()}
                className="flex-1 py-2.5 bg-red-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {t("returns_reject")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
