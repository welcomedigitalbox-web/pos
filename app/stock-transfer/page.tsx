"use client";

import { useEffect, useMemo, useState } from "react";
import {
  supabase, SellableItem,
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
  product_id: string;
  variant_id: string | null;
  to_store_id: string;
  qty: number;
  received_qty: number | null;
  status: "in_transit" | "received" | "discrepancy" | "pending_approval" | "resolved";
  transferred_by: string | null;
  received_by: string | null;
  discrepancy_note: string | null;
  discrepancy_approved_by: string | null;
  photo_url: string | null;
  resolution: "miscount" | "damaged" | null;
  resolved_by: string | null;
  created_at: string;
  display_name: string;
  sku: string | null;
};

const statusColor: Record<string, string> = {
  in_transit: "bg-yellow-100 text-yellow-700",
  pending_approval: "bg-orange-100 text-orange-700",
  resolved: "bg-slate-100 text-slate-600",
  received: "bg-green-100 text-green-700",
  discrepancy: "bg-red-100 text-red-700",
};

export default function StockTransferPage() {
  const { stores, warehouses, defaultWarehouseId } = useStore();
  const [whId, setWhId] = useState("");
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
  const [resolveRow, setResolveRow] = useState<OutgoingRow | null>(null);
  const [resolution, setResolution] = useState<"miscount" | "damaged">("miscount");
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolving, setResolving] = useState(false);

  // Only offer the stores this warehouse supplies. Unassigned stores stay listed
  // so a half-configured setup never blocks a transfer.
  // Warehouses live in the same table, so they must be excluded explicitly —
  // otherwise they slip through the "unmapped" fallback below.
  const retailStores = stores.filter(
    (s) =>
      !s.is_warehouse &&
      s.is_active &&
      (s.supply_warehouse_id === whId || !s.supply_warehouse_id)
  );

  useEffect(() => {
    if (profile && !hasPermission(profile, "stock-transfer")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!whId && defaultWarehouseId) setWhId(defaultWarehouseId);
  }, [defaultWarehouseId, whId]);

  useEffect(() => {
    if (whId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whId]);

  if (!profile || !hasPermission(profile, "stock-transfer")) return null;

  async function load() {
    setLoading(true);
    // Only stock physically available in the central warehouse can be sent
    const all = await fetchSellableItems(whId, true);
    setItems(all.filter((i) => i.stock_qty > 0));

    const { data } = await supabase
      .from("stock_transfers")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .eq("from_store_id", whId)
      .order("created_at", { ascending: false })
      .limit(200);

    setOutgoing(
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
      await upsertStoreInventory(whId, transferItem.product_id, transferItem.variant_id, {
        stock_qty: transferItem.stock_qty - qty,
      });

      const { data: created, error } = await supabase
        .from("stock_transfers")
        .insert({
          product_id: transferItem.product_id,
          variant_id: transferItem.variant_id,
          from_store_id: whId,
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

  async function submitResolution() {
    if (!resolveRow) return;
    const missing = Number(resolveRow.qty) - Number(resolveRow.received_qty ?? 0);
    if (missing <= 0) return;

    setResolving(true);
    try {
      // The warehouse was debited the full shipment, so put the missing units back
      // first. Whether they then stay on the shelf or get written off depends on
      // what actually happened.
      const { data: inv } = await (resolveRow.variant_id
        ? supabase.from("store_inventory").select("*").eq("store_id", whId)
            .eq("product_id", resolveRow.product_id).eq("variant_id", resolveRow.variant_id).maybeSingle()
        : supabase.from("store_inventory").select("*").eq("store_id", whId)
            .eq("product_id", resolveRow.product_id).is("variant_id", null).maybeSingle());

      await upsertStoreInventory(whId, resolveRow.product_id, resolveRow.variant_id, {
        stock_qty: Number(inv?.stock_qty || 0) + missing,
      });

      if (resolution === "damaged") {
        // Written off against the warehouse, which is where the loss occurred
        await supabase.from("stock_damages").insert({
          store_id: whId,
          product_id: resolveRow.product_id,
          variant_id: resolveRow.variant_id,
          qty: missing,
          reason: `Transfer shortage → ${resolveRow.to_store_id}${resolutionNote.trim() ? ` · ${resolutionNote.trim()}` : ""}`,
          reported_by: profile?.email || null,
        });

        const { data: after } = await (resolveRow.variant_id
          ? supabase.from("store_inventory").select("*").eq("store_id", whId)
              .eq("product_id", resolveRow.product_id).eq("variant_id", resolveRow.variant_id).maybeSingle()
          : supabase.from("store_inventory").select("*").eq("store_id", whId)
              .eq("product_id", resolveRow.product_id).is("variant_id", null).maybeSingle());

        await upsertStoreInventory(whId, resolveRow.product_id, resolveRow.variant_id, {
          stock_qty: Number(after?.stock_qty || 0) - missing,
        });
      }

      await supabase
        .from("stock_transfers")
        .update({
          status: "resolved",
          resolution,
          resolution_note: resolutionNote.trim() || null,
          resolved_by: profile?.email || null,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", resolveRow.id);

      await logActivity({
        entityType: "stock_transfer",
        entityId: resolveRow.id,
        action: `resolved_${resolution}`,
        detail: `${resolveRow.display_name} · ${missing} · ${resolutionNote.trim()}`,
        actor: profile?.email,
      });

      showToast(resolution === "damaged" ? t("stockTransfer_resolvedDamaged") : t("stockTransfer_resolvedMiscount"));
      setResolveRow(null);
      setResolutionNote("");
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setResolving(false);
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
  const awaitingCount = outgoing.filter((o) => o.status === "pending_approval").length;

  // The warehouse has already been debited the full amount, so anything the store
  // did not receive is a loss with no home. Surfacing it is what makes it
  // investigable rather than silently absorbed.
  const lostUnits = outgoing
    .filter((o) => o.status === "discrepancy" && o.received_qty !== null)
    .reduce((sum, o) => sum + Math.max(0, Number(o.qty) - Number(o.received_qty)), 0);

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_stockTransfer")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("stockTransfer_subtitle")}</p>

      {warehouses.length > 1 && (
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
          value={whId} onChange={(e) => setWhId(e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>🏭 {w.name}</option>)}
        </select>
      )}

      {retailStores.some((s) => !s.supply_warehouse_id) && (
        <p className="text-xs text-slate-400 mb-3">{t("stockTransfer_unassignedNote")}</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("stockTransfer_available")}</div>
          <div className="text-xl font-bold mt-1">{items.length}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("transferIn_status_in_transit")}</div>
          <div className="text-xl font-bold mt-1 text-yellow-600">{pendingCount}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("transferIn_status_pending_approval")}</div>
          <div className="text-xl font-bold mt-1 text-orange-600">{awaitingCount}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("transferIn_status_discrepancy")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{problemCount}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("stockTransfer_lostUnits")}</div>
          <div className="text-xl font-bold mt-1 text-red-600">{lostUnits.toLocaleString()}</div>
        </div>
      </div>

      {/* Available to send */}
      <h3 className="font-semibold mb-2">{t("stockTransfer_availableTitle")}</h3>
      <input
        className="w-full sm:w-96 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2"
        placeholder={t("warehouse_searchPlaceholder")}
        value={search}
        onChange={(e) => {
          const v = e.target.value;
          setSearch(v);
          const hit = items.find(
            (i) => (i.sku || "").toLowerCase() === v.trim().toLowerCase() && v.trim() !== ""
          );
          if (hit) {
            openTransfer(hit);
            setSearch("");
          }
        }}
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
          <option value="pending_approval">{t("transferIn_status_pending_approval")}</option>
          <option value="discrepancy">{t("transferIn_status_discrepancy")}</option>
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-left px-3 py-2">{t("stockTransfer_toStore")}</th>
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
            {!loading && filteredOutgoing.map((o) => {
              const diff = o.received_qty === null ? null : o.received_qty - o.qty;
              return (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{o.display_name}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{o.sku || "-"}</td>
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
                    {o.discrepancy_approved_by && (
                      <div className="text-[10px] text-slate-400">{o.discrepancy_approved_by}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{o.received_by || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    {o.status === "discrepancy" && (
                      <button onClick={() => { setResolveRow(o); setResolution("miscount"); setResolutionNote(""); }}
                        className="text-blue-600 text-xs font-medium">
                        {t("stockTransfer_resolve")}
                      </button>
                    )}
                    {o.status === "resolved" && (
                      <span className="text-xs text-slate-400">
                        {t(`stockTransfer_res_${o.resolution}` as any)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && filteredOutgoing.length === 0 && (
              <tr><td colSpan={10} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {resolveRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("stockTransfer_resolveTitle")}</h3>
            <p className="text-sm text-slate-500 mb-1">
              {resolveRow.display_name} → {resolveRow.to_store_id}
            </p>
            <p className="text-sm mb-4">
              {t("transferIn_sent")}: {resolveRow.qty} · {t("transferIn_actual")}: {resolveRow.received_qty} ·{" "}
              <span className="text-red-600 font-semibold">
                {t("stockTransfer_missing")}: {Number(resolveRow.qty) - Number(resolveRow.received_qty ?? 0)}
              </span>
            </p>

            <label className="text-sm text-slate-600">{t("stockTransfer_whatHappened")}</label>
            <div className="space-y-2 mt-2 mb-3">
              <label className="flex items-start gap-2 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                <input type="radio" className="mt-1" checked={resolution === "miscount"}
                  onChange={() => setResolution("miscount")} />
                <span className="text-sm">
                  <span className="font-medium">{t("stockTransfer_res_miscount")}</span>
                  <span className="block text-xs text-slate-500">{t("stockTransfer_miscountHint")}</span>
                </span>
              </label>
              <label className="flex items-start gap-2 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer">
                <input type="radio" className="mt-1" checked={resolution === "damaged"}
                  onChange={() => setResolution("damaged")} />
                <span className="text-sm">
                  <span className="font-medium">{t("stockTransfer_res_damaged")}</span>
                  <span className="block text-xs text-slate-500">{t("stockTransfer_damagedHint")}</span>
                </span>
              </label>
            </div>

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <textarea rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} />

            <div className="flex gap-2">
              <button onClick={() => setResolveRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitResolution} disabled={resolving}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {resolving ? "..." : t("stockTransfer_resolve")}
              </button>
            </div>
          </div>
        </div>
      )}

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
