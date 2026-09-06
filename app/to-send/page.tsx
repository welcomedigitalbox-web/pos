"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase, upsertStoreInventory, logActivity } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { useStore } from "../store-context";
import { hasPermission } from "../permissions";

type Line = {
  id: string;
  request_no: string | null;
  store_id: string;
  product_id: string;
  variant_id: string | null;
  requested_qty: number;
  requested_by: string | null;
  created_at: string;
  approved_by: string | null;
  warehouse_approved_by: string | null;
  displayName: string;
  sku: string | null;
  availableAtWh: number;
  avgCostAtWh: number;
};

export default function ToSendPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const { stores } = useStore();

  const [whId, setWhId] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(false);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [sendRow, setSendRow] = useState<Line | null>(null);
  const [sendQty, setSendQty] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");

  const warehouses = useMemo(
    () => stores.filter((s: any) => s.is_warehouse),
    [stores]
  );

  // Which shops this warehouse fills, so the list only shows its own work.
  const suppliedStores = useMemo(
    () => stores.filter((s: any) => s.supply_warehouse_id === whId).map((s: any) => s.id),
    [stores, whId]
  );

  useEffect(() => {
    if (!whId && warehouses.length) setWhId(warehouses[0].id);
  }, [warehouses, whId]);

  useEffect(() => {
    if (whId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whId, suppliedStores.length]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function load() {
    setLoading(true);

    // Only approved work reaches this screen. Anything still waiting on the
    // head belongs on the Store Requests page, not in a picker's hands.
    const { data } = await supabase
      .from("stock_requests")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .in("store_id", suppliedStores.length ? suppliedStores : ["__none__"])
      .eq("status", "approved")
      .order("created_at", { ascending: true });

    const rows = ((data as any[]) || []).map((r) => ({
      ...r,
      displayName: r.product_variants?.variant_name
        ? `${r.products?.name} (${r.product_variants.variant_name})`
        : r.products?.name || "-",
      sku: r.product_variants?.sku || r.products?.sku || null,
      availableAtWh: 0,
      avgCostAtWh: 0,
    })) as Line[];

    // One inventory read for the whole list rather than one per line.
    if (rows.length) {
      const { data: inv } = await supabase
        .from("store_inventory")
        .select("product_id, variant_id, stock_qty, avg_cost")
        .eq("store_id", whId);

      const key = (p: string, v: string | null) => `${p}:${v || "base"}`;
      const stock = new Map(
        ((inv as any[]) || []).map((i) => [
          key(i.product_id, i.variant_id),
          { qty: Number(i.stock_qty || 0), cost: Number(i.avg_cost || 0) },
        ])
      );
      for (const r of rows) {
        const hit = stock.get(key(r.product_id, r.variant_id));
        r.availableAtWh = hit?.qty ?? 0;
        r.avgCostAtWh = hit?.cost ?? 0;
      }
    }

    setLines(rows);
    setLoading(false);
  }

  const grouped = useMemo(() => {
    const byRef = new Map<string, Line[]>();
    for (const r of lines) {
      const k = r.request_no || r.id;
      byRef.set(k, [...(byRef.get(k) || []), r]);
    }
    return Array.from(byRef.entries()).map(([ref, ls]) => ({
      ref,
      lines: ls,
      store_id: ls[0].store_id,
      created_at: ls[0].created_at,
      requested_by: ls[0].requested_by,
      approved_by: ls[0].warehouse_approved_by || ls[0].approved_by,
      totalQty: ls.reduce((n, l) => n + Number(l.requested_qty || 0), 0),
      short: ls.some((l) => l.availableAtWh < l.requested_qty),
    }));
  }, [lines]);

  function openSend(l: Line) {
    setSendRow(l);
    setSendQty(String(Math.min(l.requested_qty, l.availableAtWh)));
  }

  async function submitSend() {
    if (!sendRow) return;
    const qty = Number(sendQty);
    if (!qty || qty <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (qty > sendRow.availableAtWh) return showToast(t("warehouseTransfer_notEnough"));

    setSending(true);
    try {
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
          // Cost travels with the goods; the shop cannot read warehouse rows.
          unit_cost: sendRow.avgCostAtWh,
        })
        .select()
        .single();
      if (error) throw error;

      await upsertStoreInventory(whId, sendRow.product_id, sendRow.variant_id, {
        stock_qty: sendRow.availableAtWh - qty,
      });

      await supabase
        .from("stock_requests")
        .update({ received_qty: qty })
        .eq("id", sendRow.id);

      await logActivity({
        entityType: "stock_transfer",
        entityId: (created as any)?.id,
        action: "sent",
        detail: `${sendRow.displayName} × ${qty} → ${sendRow.store_id}`,
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

  if (!profile || !hasPermission(profile, "request-inbox")) return null;

  return (
    <div className="pt-4">
      <div className="mb-4">
        <h2 className="font-semibold text-lg">{t("toSend_title")}</h2>
        <p className="text-sm text-slate-500">
          {t("toSend_subtitle")} ·{" "}
          <span className="font-semibold text-blue-600">{grouped.length}</span>
        </p>
      </div>

      {warehouses.length > 1 && (
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
          value={whId} onChange={(e) => setWhId(e.target.value)}>
          {warehouses.map((w: any) => (
            <option key={w.id} value={w.id}>🏭 {w.name}</option>
          ))}
        </select>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("stockTransfer_transferNo")}</th>
              <th className="text-left px-3 py-2">{t("requestInbox_fromStore")}</th>
              <th className="text-left px-3 py-2">{t("stockTransfer_lines")}</th>
              <th className="text-left px-3 py-2">{t("stockRequest_requestedQty")}</th>
              <th className="text-left px-3 py-2">{t("stockRequest_approved")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-8">…</td></tr>
            )}
            {!loading && grouped.map((g) => (
              <React.Fragment key={g.ref}>
                <tr className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <button onClick={() => setOpenRef(openRef === g.ref ? null : g.ref)}
                      className="text-blue-600 font-mono text-xs">
                      {g.ref}
                    </button>
                    <div className="text-[10px] text-slate-400">
                      {new Date(g.created_at).toLocaleString()}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-medium">{g.store_id}</td>
                  <td className="px-3 py-2">
                    {g.lines.length}
                    {g.short && <span className="text-red-600 ml-1">⚠️</span>}
                  </td>
                  <td className="px-3 py-2 font-medium">{g.totalQty}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{g.approved_by || "-"}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setOpenRef(openRef === g.ref ? null : g.ref)}
                      className="text-blue-600 text-xs font-medium">
                      {openRef === g.ref ? "−" : t("requestInbox_send")}
                    </button>
                  </td>
                </tr>

                {/* Picking is line by line: stock runs out one product at a
                    time, and each line leaves as its own transfer. */}
                {openRef === g.ref && g.lines.map((l) => (
                  <tr key={l.id} className="bg-slate-50 text-sm">
                    <td className="px-3 py-2 pl-8" colSpan={2}>
                      {l.displayName}
                      <div className="text-[10px] text-slate-400">{l.sku || "-"}</div>
                    </td>
                    <td className="px-3 py-2 font-medium">{l.requested_qty}</td>
                    <td className={`px-3 py-2 ${l.availableAtWh < l.requested_qty ? "text-red-600 font-medium" : ""}`}>
                      {l.availableAtWh}
                      {l.availableAtWh < l.requested_qty && " ⚠️"}
                    </td>
                    <td />
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => openSend(l)} disabled={l.availableAtWh <= 0}
                        className="text-blue-600 text-xs font-medium disabled:text-slate-300">
                        {t("requestInbox_send")}
                      </button>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {!loading && grouped.length === 0 && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-12">
                {t("toSend_empty")}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {sendRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{sendRow.displayName}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {sendRow.store_id} · {t("stockRequest_requestedQty")}: {sendRow.requested_qty} ·{" "}
              {t("requestInbox_whStock")}: {sendRow.availableAtWh}
            </p>

            <label className="text-sm text-slate-600">{t("warehouseTransfer_qty")}</label>
            <input type="number" autoFocus max={sendRow.availableAtWh}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={sendQty} onChange={(e) => setSendQty(e.target.value)} />

            <div className="flex gap-2">
              <button onClick={() => setSendRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitSend} disabled={sending}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {sending ? "…" : t("requestInbox_send")}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
