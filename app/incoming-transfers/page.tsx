"use client";

import { useEffect, useState } from "react";
import { supabase, upsertStoreInventory, logActivity } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type TransferRow = {
  id: string;
  product_id: string;
  variant_id: string | null;
  to_store_id: string;
  qty: number;
  received_qty: number | null;
  status: "in_transit" | "received" | "discrepancy";
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
  received: "bg-green-100 text-green-700",
  discrepancy: "bg-red-100 text-red-700",
};

export default function IncomingTransfersPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [confirmRow, setConfirmRow] = useState<TransferRow | null>(null);
  const [actualQty, setActualQty] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

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
    const { data } = await supabase
      .from("stock_transfers")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .eq("to_store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(100);

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
  }

  async function submitConfirm() {
    if (!confirmRow) return;
    const actual = Number(actualQty);
    if (isNaN(actual) || actual < 0) return showToast(t("stockRequest_qtyInvalid"));

    const mismatch = actual !== confirmRow.qty;
    if (mismatch && !note.trim()) return showToast(t("transferIn_noteRequired"));

    setSaving(true);
    try {
      // Credit the store with what actually arrived, not what was sent
      const { data: existing } = await (confirmRow.variant_id
        ? supabase.from("store_inventory").select("*")
            .eq("store_id", storeId).eq("product_id", confirmRow.product_id)
            .eq("variant_id", confirmRow.variant_id).maybeSingle()
        : supabase.from("store_inventory").select("*")
            .eq("store_id", storeId).eq("product_id", confirmRow.product_id)
            .is("variant_id", null).maybeSingle());

      // Carry the sending location's cost across so COGS stays meaningful
      const { data: centralInv } = await (confirmRow.variant_id
        ? supabase.from("store_inventory").select("avg_cost")
            .eq("store_id", "CENTRAL-WH").eq("product_id", confirmRow.product_id)
            .eq("variant_id", confirmRow.variant_id).maybeSingle()
        : supabase.from("store_inventory").select("avg_cost")
            .eq("store_id", "CENTRAL-WH").eq("product_id", confirmRow.product_id)
            .is("variant_id", null).maybeSingle());

      await upsertStoreInventory(storeId, confirmRow.product_id, confirmRow.variant_id, {
        stock_qty: (existing?.stock_qty || 0) + actual,
        avg_cost: centralInv?.avg_cost ?? existing?.avg_cost ?? 0,
      });

      const { error } = await supabase
        .from("stock_transfers")
        .update({
          received_qty: actual,
          status: mismatch ? "discrepancy" : "received",
          received_by: profile?.email || null,
          received_at: new Date().toISOString(),
          discrepancy_note: mismatch ? note.trim() : null,
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

      showToast(mismatch ? t("transferIn_discrepancyLogged") : t("transferIn_confirmed"));
      setConfirmRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  const pending = rows.filter((r) => r.status === "in_transit");
  const storeName = stores.find((s) => s.id === storeId)?.name || storeId;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_incomingTransfers")}</h2>
      <p className="text-sm text-slate-500 mb-4">
        {storeName} · {t("transferIn_pendingCount")}: <span className="font-semibold text-orange-600">{pending.length}</span>
      </p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
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
            {loading && <tr><td colSpan={9} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && rows.map((r) => {
              const diff = r.received_qty === null ? null : r.received_qty - r.qty;
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
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
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{r.received_by || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {r.status === "in_transit" && (
                      <button onClick={() => openConfirm(r)} className="text-blue-600 text-xs font-medium">
                        {t("transferIn_confirm")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">-</td></tr>
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
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("transferIn_notePlaceholder")}
                />
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
