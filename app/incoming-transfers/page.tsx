"use client";

import { useEffect, useState } from "react";
import { supabase, upsertStoreInventory, logActivity, uploadTransferPhoto, getTransferPhotoUrl } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission, isManagerTier, APPROVER_ROLES } from "../permissions";

type TransferRow = {
  id: string;
  product_id: string;
  variant_id: string | null;
  from_store_id: string | null;
  to_store_id: string;
  qty: number;
  received_qty: number | null;
  unit_cost: number | null;
  status: "in_transit" | "received" | "discrepancy" | "pending_approval";
  transferred_by: string | null;
  received_by: string | null;
  received_at: string | null;
  discrepancy_note: string | null;
  created_at: string;
  display_name: string;
  sku: string | null;
};

const statusColor: Record<string, string> = {
  in_transit: "bg-yellow-100 text-yellow-700",
  pending_approval: "bg-orange-100 text-orange-700",
  received: "bg-green-100 text-green-700",
  discrepancy: "bg-red-100 text-red-700",
};

export default function IncomingTransfersPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const isManagerLevel =
    isManagerTier(profile?.role) ||
    profile?.role === "owner" || profile?.role === "admin";
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [confirmRow, setConfirmRow] = useState<TransferRow | null>(null);
  const [actualQty, setActualQty] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [approvalPin, setApprovalPin] = useState("");
  const [photoLink, setPhotoLink] = useState<string | null>(null);

  useEffect(() => {
    if (profile && !hasPermission(profile, "incoming-transfers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "incoming-transfers")) return null;

  async function load() {
    setLoading(true);
    // Managers work across stores, so pinning this to the nav-selected store made
    // arrivals look like they had vanished. Cashiers still see only their own.
    let query = supabase
      .from("stock_transfers")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (!isManagerLevel) query = query.eq("to_store_id", storeId);
    const { data } = await query;

    setRows(
      ((data as any[]) || []).map((r) => ({
        ...r,
        display_name: r.product_variants?.variant_name
          ? `${r.products?.name} (${r.product_variants.variant_name})`
          : r.products?.name || "-",
        sku: r.product_variants?.sku || r.products?.sku || null,
      }))
    );
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function openConfirm(row: TransferRow) {
    setConfirmRow(row);
    setActualQty(String(row.qty));
    setNote("");
    setPhotoFile(null);
    setApprovalPin("");
  }

  async function submitConfirm() {
    if (!confirmRow) return;
    const actual = Number(actualQty);
    if (isNaN(actual) || actual < 0) return showToast(t("stockRequest_qtyInvalid"));

    const mismatch = actual !== confirmRow.qty;
    if (mismatch && !note.trim()) return showToast(t("transferIn_noteRequired"));
    if (mismatch && !photoFile) return showToast(t("transferIn_photoRequired"));
    setSaving(true);
    try {
      // A discrepancy writes off stock, so it needs a manager. Either they enter a
      // PIN here, or it waits in pending_approval for them to approve from their
      // own account — same two paths as a sale return.
      let approvedBy: string | null = isManagerLevel ? profile?.email || null : null;
      if (mismatch && !isManagerLevel && approvalPin.trim()) {
        const { data: verify, error: verifyErr } = await supabase.functions.invoke(
          "verify-discount-approver",
          { body: { pin: approvalPin.trim() } }
        );
        if (verifyErr) throw verifyErr;
        if (!verify?.approved) {
          setSaving(false);
          return showToast("❌ " + (verify?.error || t("returns_pinInvalid")));
        }
        approvedBy = verify.approver_email;
      }

      const needsApproval = mismatch && !approvedBy;

      let photoPath: string | null = null;
      if (photoFile) photoPath = await uploadTransferPhoto(photoFile, storeId, confirmRow.id);

      // Credit the store with what actually arrived, not what was sent
      const { data: existing } = await (confirmRow.variant_id
        ? supabase.from("store_inventory").select("*")
            .eq("store_id", storeId).eq("product_id", confirmRow.product_id)
            .eq("variant_id", confirmRow.variant_id).maybeSingle()
        : supabase.from("store_inventory").select("*")
            .eq("store_id", storeId).eq("product_id", confirmRow.product_id)
            .is("variant_id", null).maybeSingle());

      // Carry the SENDING location's cost across. This used to look at a
      // hardcoded warehouse id, so any other warehouse produced a zero cost.
      const sourceStore = confirmRow.from_store_id || "";
      const { data: sourceInv } = await (confirmRow.variant_id
        ? supabase.from("store_inventory").select("avg_cost")
            .eq("store_id", sourceStore).eq("product_id", confirmRow.product_id)
            .eq("variant_id", confirmRow.variant_id).maybeSingle()
        : supabase.from("store_inventory").select("avg_cost")
            .eq("store_id", sourceStore).eq("product_id", confirmRow.product_id)
            .is("variant_id", null).maybeSingle());

      if (!needsApproval) {
        // Weighted average, so receiving at a different cost doesn't overwrite
        // what the store already holds
        // The transfer carries its own cost. sourceInv is a fallback for rows
        // created before that column existed, and is null anyway whenever RLS
        // hides the sending warehouse from this account.
        const stampedCost = Number((confirmRow as any).unit_cost || 0);
        const incomingCost = stampedCost > 0
          ? stampedCost
          : Number(sourceInv?.avg_cost ?? existing?.avg_cost ?? 0);
        const heldQty = Number(existing?.stock_qty || 0);
        const heldCost = Number(existing?.avg_cost || 0);
        const newQty = heldQty + actual;
        const newAvg =
          newQty > 0 ? (heldQty * heldCost + actual * incomingCost) / newQty : incomingCost;

        await upsertStoreInventory(storeId, confirmRow.product_id, confirmRow.variant_id, {
          stock_qty: newQty,
          avg_cost: newAvg,
          last_purchase_cost: incomingCost,
        });

        // Batches carry the expiry dates, so they have to move with the goods —
        // otherwise the receiving store shows stock with no expiry at all.
        let batchQuery = supabase
          .from("stock_purchases")
          .select("*")
          .eq("store_id", sourceStore)
          .eq("product_id", confirmRow.product_id)
          .gt("remaining_qty", 0);
        batchQuery = confirmRow.variant_id
          ? batchQuery.eq("variant_id", confirmRow.variant_id)
          : batchQuery.is("variant_id", null);
        const { data: sourceBatches } = await batchQuery.order("expiry_date", {
          ascending: true,
          nullsFirst: false,
        });

        // First to expire leaves first
        let toMove = actual;
        for (const b of (sourceBatches as any[]) || []) {
          if (toMove <= 0) break;
          const take = Math.min(toMove, Number(b.remaining_qty));

          await supabase
            .from("stock_purchases")
            .update({ remaining_qty: Number(b.remaining_qty) - take })
            .eq("id", b.id);

          await supabase.from("stock_purchases").insert({
            product_id: confirmRow.product_id,
            variant_id: confirmRow.variant_id,
            store_id: storeId,
            supplier: b.supplier,
            qty: take,
            unit_cost: b.unit_cost,
            total_cost: take * Number(b.unit_cost),
            new_avg_cost: newAvg,
            remaining_qty: take,
            expiry_date: b.expiry_date,
            received_by: profile?.email || null,
            received_at: new Date().toISOString(),
          });

          toMove -= take;
        }
      }

      const { error } = await supabase
        .from("stock_transfers")
        .update({
          received_qty: actual,
          status: needsApproval ? "pending_approval" : mismatch ? "discrepancy" : "received",
          received_by: profile?.email || null,
          received_at: new Date().toISOString(),
          discrepancy_note: mismatch ? note.trim() : null,
          photo_url: photoPath,
          discrepancy_approved_by: mismatch ? approvedBy : null,
        })
        .eq("id", confirmRow.id);
      if (error) throw error;

      await logActivity({
        entityType: "stock_transfer",
        entityId: confirmRow.id,
        action: mismatch ? "received_with_discrepancy" : "received",
        detail: `${confirmRow.display_name}: ${t("transferIn_sent")} ${confirmRow.qty} → ${t("transferIn_actual")} ${actual}${mismatch ? ` · ${note.trim()}` : ""}`,
        actor: profile?.email,
      });

      showToast(
        needsApproval
          ? t("transferIn_awaitingApproval")
          : mismatch
          ? t("transferIn_discrepancyLogged")
          : t("transferIn_confirmed")
      );
      setConfirmRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function approveDiscrepancy(r: TransferRow) {
    if (!confirm(t("transferIn_approveConfirm"))) return;
    try {
      const { data: existing } = await (r.variant_id
        ? supabase.from("store_inventory").select("*").eq("store_id", r.to_store_id)
            .eq("product_id", r.product_id).eq("variant_id", r.variant_id).maybeSingle()
        : supabase.from("store_inventory").select("*").eq("store_id", r.to_store_id)
            .eq("product_id", r.product_id).is("variant_id", null).maybeSingle());

      await upsertStoreInventory(r.to_store_id, r.product_id, r.variant_id, {
        stock_qty: Number(existing?.stock_qty || 0) + Number(r.received_qty ?? 0),
      });

      await supabase
        .from("stock_transfers")
        .update({ status: "discrepancy", discrepancy_approved_by: profile?.email || null })
        .eq("id", r.id);

      await logActivity({
        entityType: "stock_transfer",
        entityId: r.id,
        action: "discrepancy_approved",
        detail: `${r.display_name}: ${t("transferIn_sent")} ${r.qty} → ${t("transferIn_actual")} ${r.received_qty}`,
        actor: profile?.email,
      });

      showToast(t("transferIn_discrepancyLogged"));
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    }
  }

  const pending = rows.filter((r) => r.status === "in_transit");
  const awaitingApproval = rows.filter((r) => r.status === "pending_approval");
  const storeName = stores.find((s) => s.id === storeId)?.name || storeId;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_incomingTransfers")}</h2>
      <p className="text-sm text-slate-500 mb-4">
        {storeName} · {t("transferIn_pendingCount")}:{" "}
        <span className="font-semibold text-orange-600">{pending.length}</span>
        {awaitingApproval.length > 0 && (
          <>
            {" · "}
            <span className="font-semibold text-red-600">
              {t("transferIn_status_pending_approval")}: {awaitingApproval.length}
            </span>
          </>
        )}
      </p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              {isManagerLevel && <th className="text-left px-3 py-2">{t("stockTransfer_toStore")}</th>}
              <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_sent")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_actual")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_diff")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && rows.map((r) => {
              const diff = r.received_qty === null ? null : r.received_qty - r.qty;
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                  {isManagerLevel && <td className="px-3 py-2 font-medium">{r.to_store_id}</td>}
                  <td className="px-3 py-2">{r.display_name}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{r.sku || "-"}</td>
                  <td className="px-3 py-2">{r.qty}</td>
                  <td className="px-3 py-2 font-medium">{r.received_qty ?? "-"}</td>
                  <td className={`px-3 py-2 font-medium ${diff ? "text-red-600" : "text-slate-400"}`}>
                    {diff === null ? "-" : diff === 0 ? "0" : diff > 0 ? `+${diff}` : diff}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status]}`}>
                      {t(`transferIn_status_${r.status}` as any)}
                    </span>
                    {r.discrepancy_note && (
                      <div className="text-[10px] text-red-600 mt-0.5">{r.discrepancy_note}</div>
                    )}
                    {(r as any).discrepancy_approved_by && (
                      <div className="text-[10px] text-slate-400">
                        {t("returns_approve")}: {(r as any).discrepancy_approved_by}
                      </div>
                    )}
                    {(r as any).photo_url && (
                      <button
                        onClick={async () => setPhotoLink(await getTransferPhotoUrl((r as any).photo_url))}
                        className="text-[10px] text-blue-600 font-medium"
                      >
                        📎 {t("transferIn_viewPhoto")}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{r.received_by || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "in_transit" && (
                      <button onClick={() => openConfirm(r)} className="text-blue-600 text-xs font-medium">
                        {t("transferIn_confirm")}
                      </button>
                    )}
                    {r.status === "pending_approval" && (
                      isManagerLevel ? (
                        <button onClick={() => approveDiscrepancy(r)} className="text-green-600 text-xs font-medium">
                          {t("returns_approve")}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">{t("transferIn_awaitingManager")}</span>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("transferIn_confirm")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {confirmRow.display_name} · {t("transferIn_sent")}: {confirmRow.qty}
            </p>

            <label className="text-sm text-slate-600">{t("transferIn_actual")}</label>
            <input
              type="number"
              autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={actualQty}
              onChange={(e) => setActualQty(e.target.value)}
            />

            {Number(actualQty) !== confirmRow.qty && (
              <>
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 mb-3">
                  ⚠️ {t("transferIn_mismatchWarning")} ({Number(actualQty) - confirmRow.qty})
                </div>
                <label className="text-sm text-slate-600">
                  {t("transferIn_note")} <span className="text-red-600">*</span>
                </label>
                <textarea
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("transferIn_notePlaceholder")}
                />

                <label className="text-sm text-slate-600">
                  {t("transferIn_photo")} <span className="text-red-600">*</span>
                </label>
                <input type="file" accept="image/*" capture="environment"
                  className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs mt-1 mb-3"
                  onChange={(e) => setPhotoFile(e.target.files?.[0] || null)} />

                {!isManagerLevel && (
                  <>
                    <label className="text-sm text-slate-600">{t("returns_managerPin")}</label>
                    <p className="text-[10px] text-slate-400">{t("transferIn_pinOptional")}</p>
                    <input type="password" inputMode="numeric"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4 tracking-widest text-center"
                      placeholder="••••"
                      value={approvalPin} onChange={(e) => setApprovalPin(e.target.value)} />
                  </>
                )}
              </>
            )}

            <div className="flex gap-2">
              <button onClick={() => setConfirmRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitConfirm} disabled={saving}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("transferIn_confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {photoLink && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          onClick={() => setPhotoLink(null)}>
          <img src={photoLink} alt="" className="max-h-[80vh] max-w-full rounded-lg" />
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
