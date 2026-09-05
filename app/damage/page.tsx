"use client";

import { useEffect, useState } from "react";
import { supabase, SellableItem, fetchSellableItems, upsertStoreInventory } from "@/lib/supabase";
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
  variant_id: string | null;
  products: { name: string } | null;
  product_variants: { variant_name: string } | null;
};

export default function DamagePage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [items, setItems] = useState<SellableItem[]>([]);
  const [history, setHistory] = useState<DamageRow[]>([]);
  const [toast, setToast] = useState("");

  const [itemKey, setItemKey] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  // A breakage usually covers several items at once; the lines are held
  // here until the whole report goes in under one number.
  const [draftLines, setDraftLines] = useState<{ key: string; qty: number; reason: string }[]>([]);

  useEffect(() => {
    if (profile && !hasPermission(profile, "damage")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadItems();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "damage")) return null;

  async function loadItems() {
    const data = await fetchSellableItems(storeId);
    setItems(data);
  }

  async function loadHistory() {
    const { data } = await supabase
      .from("stock_damages")
      .select("*, products(name), product_variants(variant_name)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    setHistory((data as unknown as DamageRow[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function addLine() {
    const item = items.find((i) => i.key === itemKey);
    const qtyNum = Number(qty);
    if (!item) return showToast(t("stockIn_selectProduct"));
    if (!qtyNum || qtyNum <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (qtyNum > item.stock_qty) return showToast(t("damage_notEnoughStock"));
    if (draftLines.find((l) => l.key === item.key)) {
      return showToast(t("warehouseTransfer_lineExists"));
    }
    setDraftLines([...draftLines, { key: item.key, qty: qtyNum, reason: reason.trim() }]);
    setItemKey(""); setQty(""); setReason("");
  }

  async function submitDamage(e: React.FormEvent) {
    e.preventDefault();

    // Whatever is still in the picker counts as a line, so a single-item
    // report does not need the add button pressed first.
    const lines = [...draftLines];
    const pending = items.find((i) => i.key === itemKey);
    const pendingQty = Number(qty);
    if (pending && pendingQty > 0 && !lines.find((l) => l.key === pending.key)) {
      if (pendingQty > pending.stock_qty) return showToast(t("damage_notEnoughStock"));
      lines.push({ key: pending.key, qty: pendingQty, reason: reason.trim() });
    }
    if (!lines.length) return showToast(t("stockIn_selectProduct"));

    setSaving(true);
    try {
      // The RPC takes the stock off, walks the batches oldest-expiry first
      // and files the report awaiting approval, all in one transaction.
      const payload = lines.map((l) => {
        const it = items.find((i) => i.key === l.key)!;
        return {
          product_id: it.product_id,
          variant_id: it.variant_id || "",
          qty: l.qty,
          reason: l.reason || null,
        };
      });

      const { data, error } = await supabase.rpc("report_damage", {
        p_store_id: storeId,
        p_lines: payload,
        p_note: null,
      });
      if (error) throw error;

      showToast(`${t("damage_recorded")} \u00b7 ${data}`);
      setDraftLines([]); setItemKey(""); setQty(""); setReason("");
      await loadItems();
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("\u274c " + message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-4 grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4 h-fit">
        <h2 className="font-semibold mb-3">{t("nav_damage")}</h2>
        <form onSubmit={submitDamage}>
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
            <button type="button" onClick={addLine}
              className="w-full py-2 border border-slate-200 rounded-lg text-sm font-medium mb-3">
              + {t("warehouseTransfer_addLine")}
            </button>

            {draftLines.length > 0 && (
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 mb-3">
                {draftLines.map((l) => {
                  const it = items.find((i) => i.key === l.key);
                  return (
                    <div key={l.key} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="truncate">{it?.display_name || l.key}</span>
                      <span className="flex items-center gap-3 shrink-0">
                        <span className="font-medium">{l.qty}</span>
                        <button type="button"
                          onClick={() => setDraftLines(draftLines.filter((x) => x.key !== l.key))}
                          className="text-red-600 text-xs">
                          {t("products_cancel")}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}


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
                  <td className="px-3 py-2">
                    {h.products?.name || "-"}
                    {h.product_variants?.variant_name && (
                      <span className="text-blue-600 text-xs ml-1">({h.product_variants.variant_name})</span>
                    )}
                  </td>
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
