"use client";

import { useEffect, useMemo, useState } from "react";
import {
  supabase, CENTRAL_WAREHOUSE_ID, SellableItem,
  fetchSellableItems, upsertStoreInventory, logActivity,
} from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type OutgoingRow = {
  id: string;
  to_store_id: string;
  qty: number;
  received_qty: number | null;
  status: "in_transit" | "received" | "discrepancy";
  transferred_by: string | null;
  received_by: string | null;
  discrepancy_note: string | null;
  created_at: string;
  display_name: string;
};

const statusColor: Record<string, string> = {
  in_transit: "bg-yellow-100 text-yellow-700",
  received: "bg-green-100 text-green-700",
  discrepancy: "bg-red-100 text-red-700",
};

export default function StockTransferPage() {
  const { stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [items, setItems] = useState<SellableItem[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [storeFilter, setStoreFilter] = useState("all");

  const [transferItem, setTransferItem] = useState<SellableItem | null>(null);
  const [transferQty, setTransferQty] = useState("");
  const [transferToStore, setTransferToStore] = useState("");
  const [sending, setSending] = useState(false);

  const retailStores = stores.filter((s) => !s.is_warehouse);

  useEffect(() => {
    if (profile && !hasPermission(profile, "stock-transfer")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "stock-transfer")) return null;

  async function load() {
    setLoading(true);
    // Only stock physically available in the central warehouse can be sent
    const all = await fetchSellableItems(CENTRAL_WAREHOUSE_ID, true);
    setItems(all.filter((i) => i.stock_qty > 0));

    const { data } = await supabase
      .from("stock_transfers")
      .select("*, products(name), product_variants(variant_name)")
      .order("created_at", { ascending: false })
      .limit(200);

    setOutgoing(
      ((data as any[]) || []).map((r) => ({
        ...r,
        display_name: r.product_variants?.variant_name
          ? `${r.products?.name} (${r.product_variants.variant_name})`
          : r.products?.name || "-",
      }))
    );
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function openTransfer(item: SellableItem) {
    setTransferItem(item);
    setTransferQty("");
    setTransferToStore(retailStores[0]?.id || "");
  }

  async function submitTransfer() {
    if (!transferItem) return;
    const qty = Number(transferQty);
    if (!qty || qty <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (qty > transferItem.stock_qty) return showToast(t("warehouseTransfer_notEnough"));
    if (!transferToStore) return;

    setSending(true);
    try {
      await upsertStoreInventory(CENTRAL_WAREHOUSE_ID, transferItem.product_id, transferItem.variant_id, {
        stock_qty: transferItem.stock_qty - qty,
      });

      const { data: created, error } = await supabase
        .from("stock_transfers")
        .insert({
          product_id: transferItem.product_id,
          variant_id: transferItem.variant_id,
          to_store_id: transferToStore,
          qty,
          status: "in_transit",
          transferred_by: profile?.email || null,
        })
        .select()
        .single();
      if (error) throw error;

      await logActivity({
        entityType: "stock_transfer",
        entityId: created.id,
        action: "sent",
        detail: `${transferItem.display_name} × ${qty} → ${transferToStore}`,
        actor: profile?.email,
      });

      showToast(t("warehouseTransfer_sent"));
      setTransferItem(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSending(false);
    }
  }

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.display_name.toLowerCase().includes(q) || (i.sku || "").toLowerCase().includes(q)
    );
  }, [items, search]);

  const filteredOutgoing = useMemo(
    () =>
      outgoing.filter((o) => {
        if (statusFilter !== "all" && o.status !== statusFilter) return false;
        if (storeFilter !== "all" && o.to_store_id !== storeFilter) return false;
        return true;
      }),
    [outgoing, statusFilter, storeFilter]
  );

  const pendingCount = outgoing.filter((o) => o.status === "in_transit").length;
  const problemCount = outgoing.filter((o) => o.status === "discrepancy").length;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_stockTransfer")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("stockTransfer_subtitle")}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("stockTransfer_available")}</div>
          <div className="text-xl font-bold mt-1">{items.length}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("transferIn_status_in_transit")}</div>
          <div className="text-xl font-bold mt-1 text-yellow-600">{pendingCount}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("transferIn_status_discrepancy")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{problemCount}</div>
        </div>
      </div>

      {/* Available to send */}
      <h3 className="font-semibold mb-2">{t("stockTransfer_availableTitle")}</h3>
      <input
        className="w-full sm:w-96 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2"
        placeholder={t("warehouse_searchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvailable")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colAvgCost")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filteredItems.map((i) => (
              <tr key={i.key} className="border-t border-slate-100">
                <td className="px-3 py-2">{i.display_name}</td>
                <td className="px-3 py-2 text-slate-400">{i.sku || "-"}</td>
                <td className="px-3 py-2 font-medium">{i.stock_qty.toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-500">{fmt(i.avg_cost)}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => openTransfer(i)} className="text-blue-600 text-xs font-medium">
                    {t("warehouseTransfer_button")}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && filteredItems.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-400 py-8">{t("stockTransfer_noneAvailable")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Outgoing tracking */}
      <h3 className="font-semibold mb-2">{t("stockTransfer_outgoingTitle")}</h3>
      <div className="flex flex-wrap gap-2 mb-2">
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
          <option value="all">{t("warehouse_allStores")}</option>
          {retailStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">{t("warehouse_allStock")}</option>
          <option value="in_transit">{t("transferIn_status_in_transit")}</option>
          <option value="received">{t("transferIn_status_received")}</option>
          <option value="discrepancy">{t("transferIn_status_discrepancy")}</option>
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("stockTransfer_toStore")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_sent")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_actual")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_diff")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filteredOutgoing.map((o) => {
              const diff = o.received_qty === null ? null : o.received_qty - o.qty;
              return (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{o.display_name}</td>
                  <td className="px-3 py-2">{o.to_store_id}</td>
                  <td className="px-3 py-2">{o.qty}</td>
                  <td className="px-3 py-2 font-medium">{o.received_qty ?? "-"}</td>
                  <td className={`px-3 py-2 font-medium ${diff ? "text-red-600" : "text-slate-400"}`}>
                    {diff === null ? "-" : diff === 0 ? "0" : diff > 0 ? `+${diff}` : diff}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[o.status]}`}>
                      {t(`transferIn_status_${o.status}` as any)}
                    </span>
                    {o.discrepancy_note && (
                      <div className="text-[10px] text-red-600 mt-0.5">{o.discrepancy_note}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{o.received_by || "-"}</td>
                </tr>
              );
            })}
            {!loading && filteredOutgoing.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {transferItem && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("warehouseTransfer_title")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {transferItem.display_name} · {t("warehouseTransfer_available")}: {transferItem.stock_qty}
            </p>

            <label className="text-sm text-slate-600">{t("warehouseTransfer_toStore")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={transferToStore} onChange={(e) => setTransferToStore(e.target.value)}>
              {retailStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            <label className="text-sm text-slate-600">{t("warehouseTransfer_qty")}</label>
            <input type="number" autoFocus max={transferItem.stock_qty}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={transferQty} onChange={(e) => setTransferQty(e.target.value)} />

            <div className="flex gap-2">
              <button onClick={() => setTransferItem(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitTransfer} disabled={sending}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {sending ? "..." : t("warehouseTransfer_button")}
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
