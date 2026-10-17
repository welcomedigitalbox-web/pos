"use client";

import { Fragment, useEffect, useState } from "react";
import { supabase, upsertStoreInventory, logActivity, uploadTransferPhoto, getTransferPhotoUrl } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission, isManagerTier } from "../permissions";

type TransferRow = {
  id: string;
  transfer_no: string | null;
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

// A delivery is one shipment, not a pile of loose lines. The page groups by the
// transfer number so a person signs for what actually turned up at the door.
type Group = {
  ref: string;
  created_at: string;
  from_store_id: string | null;
  to_store_id: string;
  transferred_by: string | null;
  received_by: string | null;
  received_at: string | null;
  lines: TransferRow[];
  sentQty: number;
  gotQty: number | null;
  status: string;
};

const statusColor: Record<string, string> = {
  in_transit: "bg-yellow-100 text-yellow-700",
  pending_approval: "bg-orange-100 text-orange-700",
  received: "bg-green-100 text-green-700",
  discrepancy: "bg-red-100 text-red-700",
  mixed: "bg-slate-100 text-slate-600",
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
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const [confirmGroup, setConfirmGroup] = useState<Group | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [approvalPin, setApprovalPin] = useState("");
  const [photoLink, setPhotoLink] = useState<string | null>(null);
  const [printGroup, setPrintGroup] = useState<Group | null>(null);

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
      .limit(500);
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

  // Rows that arrived together share a transfer number. Older rows predate it,
  // so they fall back to their own id and simply appear on their own.
  const groups: Group[] = (() => {
    const by = new Map<string, Group>();
    for (const r of rows) {
      const ref = r.transfer_no || r.id;
      let g = by.get(ref);
      if (!g) {
        g = {
          ref,
          created_at: r.created_at,
          from_store_id: r.from_store_id,
          to_store_id: r.to_store_id,
          transferred_by: r.transferred_by,
          received_by: r.received_by,
          received_at: r.received_at,
          lines: [],
          sentQty: 0,
          gotQty: null,
          status: r.status,
        };
        by.set(ref, g);
      }
      g.lines.push(r);
      g.sentQty += Number(r.qty || 0);
      if (r.received_qty !== null) g.gotQty = Number(g.gotQty || 0) + Number(r.received_qty);
      if (g.status !== r.status) g.status = "mixed";
      if (!g.received_by && r.received_by) g.received_by = r.received_by;
      if (!g.received_at && r.received_at) g.received_at = r.received_at;
    }
    return Array.from(by.values());
  })();

  function openConfirm(g: Group) {
    const pending = g.lines.filter((l) => l.status === "in_transit");
    setConfirmGroup({ ...g, lines: pending });
    const c: Record<string, string> = {};
    for (const l of pending) c[l.id] = String(l.qty);
    setCounts(c);
    setNote("");
    setPhotoFile(null);
    setApprovalPin("");
  }

  /** Move one line's goods into the receiving store: stock, average cost and
   *  the batches that carry the expiry dates. */
  async function applyLine(line: TransferRow, actual: number) {
    const dest = line.to_store_id;

    const { data: existing } = await (line.variant_id
      ? supabase.from("store_inventory").select("*")
          .eq("store_id", dest).eq("product_id", line.product_id)
          .eq("variant_id", line.variant_id).maybeSingle()
      : supabase.from("store_inventory").select("*")
          .eq("store_id", dest).eq("product_id", line.product_id)
          .is("variant_id", null).maybeSingle());

    const sourceStore = line.from_store_id || "";
    const { data: sourceInv } = await (line.variant_id
      ? supabase.from("store_inventory").select("avg_cost")
          .eq("store_id", sourceStore).eq("product_id", line.product_id)
          .eq("variant_id", line.variant_id).maybeSingle()
      : supabase.from("store_inventory").select("avg_cost")
          .eq("store_id", sourceStore).eq("product_id", line.product_id)
          .is("variant_id", null).maybeSingle());

    const stampedCost = Number(line.unit_cost || 0);
    const incomingCost = stampedCost > 0
      ? stampedCost
      : Number(sourceInv?.avg_cost ?? existing?.avg_cost ?? 0);
    const heldQty = Number(existing?.stock_qty || 0);
    const heldCost = Number(existing?.avg_cost || 0);
    const newQty = heldQty + actual;
    const newAvg =
      newQty > 0 ? (heldQty * heldCost + actual * incomingCost) / newQty : incomingCost;

    await upsertStoreInventory(dest, line.product_id, line.variant_id, {
      stock_qty: newQty,
      avg_cost: newAvg,
      last_purchase_cost: incomingCost,
    });

    let batchQuery = supabase
      .from("stock_purchases")
      .select("*")
      .eq("store_id", sourceStore)
      .eq("product_id", line.product_id)
      .gt("remaining_qty", 0);
    batchQuery = line.variant_id
      ? batchQuery.eq("variant_id", line.variant_id)
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
        product_id: line.product_id,
        variant_id: line.variant_id,
        store_id: dest,
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

  async function submitConfirm() {
    if (!confirmGroup) return;
    const lines = confirmGroup.lines;

    for (const l of lines) {
      const n = Number(counts[l.id]);
      if (isNaN(n) || n < 0) return showToast(t("stockRequest_qtyInvalid"));
    }
    const shortLines = lines.filter((l) => Number(counts[l.id]) !== l.qty);
    const mismatch = shortLines.length > 0;
    if (mismatch && !note.trim()) return showToast(t("transferIn_noteRequired"));
    if (mismatch && !photoFile) return showToast(t("transferIn_photoRequired"));

    setSaving(true);
    try {
      // A short delivery writes off stock, so it needs a manager. Either they
      // enter a PIN here, or it waits in pending_approval for them to approve
      // from their own account.
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

      let photoPath: string | null = null;
      if (photoFile) {
        photoPath = await uploadTransferPhoto(photoFile, confirmGroup.to_store_id, confirmGroup.ref);
      }

      for (const l of lines) {
        const actual = Number(counts[l.id]);
        const lineShort = actual !== l.qty;
        const needsApproval = lineShort && !approvedBy;

        if (!needsApproval) await applyLine(l, actual);

        const { error } = await supabase
          .from("stock_transfers")
          .update({
            received_qty: actual,
            status: needsApproval ? "pending_approval" : lineShort ? "discrepancy" : "received",
            received_by: profile?.email || null,
            received_at: new Date().toISOString(),
            discrepancy_note: lineShort ? note.trim() : null,
            photo_url: lineShort ? photoPath : null,
            discrepancy_approved_by: lineShort ? approvedBy : null,
          })
          .eq("id", l.id);
        if (error) throw error;
      }

      await logActivity({
        entityType: "stock_transfer",
        entityId: confirmGroup.ref,
        action: mismatch ? "received_with_discrepancy" : "received",
        detail: `${confirmGroup.ref}: ${lines.length} lines · ${t("transferIn_sent")} ${confirmGroup.sentQty} → ${t("transferIn_actual")} ${lines.reduce((s, l) => s + Number(counts[l.id] || 0), 0)}${mismatch ? ` · ${note.trim()}` : ""}`,
        actor: profile?.email,
      });

      showToast(
        mismatch && !approvedBy
          ? t("transferIn_awaitingApproval")
          : mismatch
          ? t("transferIn_discrepancyLogged")
          : t("transferIn_confirmed")
      );
      setConfirmGroup(null);
      await load();
    } catch (err) {
      showToast("❌ " + ((err as { message?: string })?.message ?? JSON.stringify(err)));
    } finally {
      setSaving(false);
    }
  }

  async function approveGroup(g: Group) {
    if (!confirm(t("transferIn_approveConfirm"))) return;
    try {
      for (const r of g.lines.filter((l) => l.status === "pending_approval")) {
        await applyLine(r, Number(r.received_qty ?? 0));
        await supabase
          .from("stock_transfers")
          .update({ status: "discrepancy", discrepancy_approved_by: profile?.email || null })
          .eq("id", r.id);
      }
      await logActivity({
        entityType: "stock_transfer",
        entityId: g.ref,
        action: "discrepancy_approved",
        detail: `${g.ref}: ${t("transferIn_sent")} ${g.sentQty} → ${t("transferIn_actual")} ${g.gotQty ?? 0}`,
        actor: profile?.email,
      });
      showToast(t("transferIn_discrepancyLogged"));
      await load();
    } catch (err) {
      showToast("❌ " + ((err as { message?: string })?.message ?? JSON.stringify(err)));
    }
  }

  // Printing through the page fought the app's own print styles, so the
  // note is written into a window of its own instead.
  function printReceipt(g: Group) {
    const esc = (s: unknown) =>
      String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
    const lines = g.lines.map((l) => (
      `<tr><td>${esc(l.display_name)}</td><td>${esc(l.sku || "-")}</td>` +
      `<td class=r>${esc(l.qty)}</td><td class=r>${esc(l.received_qty ?? "-")}</td></tr>`
    )).join("");
    const html =
      `<!doctype html><meta charset=utf-8><title>${esc(g.ref)}</title>` +
      `<style>body{font:13px -apple-system,sans-serif;padding:24px}` +
      `h1{font-size:16px;margin:0 0 8px}table{width:100%;border-collapse:collapse;font-size:12px}` +
      `th,td{text-align:left;padding:4px 0;border-bottom:1px solid #eee}.r{text-align:right}` +
      `.meta{font-size:11px;color:#555;margin-bottom:14px}.sig{margin-top:60px;display:flex;` +
      `justify-content:space-between;font-size:11px}</style>` +
      `<h1>Goods received note</h1><div class=meta>` +
      `No: ${esc(g.ref)}<br>${esc(g.from_store_id || "-")} &rarr; ${esc(g.to_store_id)}<br>` +
      `Sent: ${esc(new Date(g.created_at).toLocaleString())}` +
      `${g.received_at ? `<br>Received: ${esc(new Date(g.received_at).toLocaleString())} \u00b7 ${esc(g.received_by)}` : ""}` +
      `</div><table><thead><tr><th>Product</th><th>Code</th><th class=r>Sent</th>` +
      `<th class=r>Received</th></tr></thead><tbody>${lines}` +
      `<tr><td colspan=2><b>Total</b></td><td class=r><b>${g.sentQty}</b></td>` +
      `<td class=r><b>${g.gotQty ?? "-"}</b></td></tr></tbody></table>` +
      `<div class=sig><div>Received by ______________________</div>` +
      `<div>Checked by ______________________</div></div>`;
    const w = window.open("", "_blank", "width=800,height=900");
    if (!w) return showToast("Allow pop-ups to print this note");
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }
  const pendingGroups = groups.filter((g) => g.lines.some((l) => l.status === "in_transit"));
  const approvalGroups = groups.filter((g) => g.lines.some((l) => l.status === "pending_approval"));
  const storeName = stores.find((s) => s.id === storeId)?.name || storeId;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1 print:hidden">{t("nav_incomingTransfers")}</h2>
      <p className="text-sm text-slate-500 mb-4 print:hidden">
        {storeName} · {t("transferIn_pendingCount")}:{" "}
        <span className="font-semibold text-orange-600">{pendingGroups.length}</span>
        {approvalGroups.length > 0 && (
          <>
            {" · "}
            <span className="font-semibold text-red-600">
              {t("transferIn_status_pending_approval")}: {approvalGroups.length}
            </span>
          </>
        )}
      </p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto print:hidden">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 w-6"></th>
              <th className="text-left px-3 py-2">No.</th>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("stockTransfer_toStore")}</th>
              <th className="text-left px-3 py-2">{t("stockTransfer_lines")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_sent")}</th>
              <th className="text-left px-3 py-2">{t("transferIn_actual")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && groups.map((g) => {
              const diff = g.gotQty === null ? null : g.gotQty - g.sentQty;
              const canConfirm = g.lines.some((l) => l.status === "in_transit");
              const canApprove = g.lines.some((l) => l.status === "pending_approval");
              return (
                <Fragment key={g.ref}>
                  <tr className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setOpen((p) => ({ ...p, [g.ref]: !p[g.ref] }))}
                        className="text-slate-400 text-xs">
                        {open[g.ref] ? "▾" : "▸"}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{g.ref}</td>
                    <td className="px-3 py-2">{new Date(g.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {g.from_store_id || "-"} → {g.to_store_id}
                    </td>
                    <td className="px-3 py-2">{g.lines.length}</td>
                    <td className="px-3 py-2 font-medium">{g.sentQty}</td>
                    <td className={`px-3 py-2 font-medium ${diff ? "text-red-600" : ""}`}>
                      {g.gotQty === null ? "-" : g.gotQty}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[g.status] || statusColor.mixed}`}>
                        {g.status === "mixed"
                          ? t("stockTransfer_statusMixed")
                          : t(`transferIn_status_${g.status}` as any)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{g.received_by || "-"}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {canConfirm && (
                        <button onClick={() => openConfirm(g)}
                          className="text-blue-600 text-xs font-medium mr-3">
                          {t("transferIn_confirm")}
                        </button>
                      )}
                      {canApprove && (
                        isManagerLevel ? (
                          <button onClick={() => approveGroup(g)}
                            className="text-green-600 text-xs font-medium mr-3">
                            {t("returns_approve")}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400 mr-3">{t("transferIn_awaitingManager")}</span>
                        )
                      )}
                      <a href={`/stock-transfer/${encodeURIComponent(g.ref)}`}
                        className="text-slate-600 text-xs font-medium">
                        PDF
                      </a>
                    </td>
                  </tr>

                  {open[g.ref] && g.lines.map((l) => {
                    const d = l.received_qty === null ? null : l.received_qty - l.qty;
                    return (
                      <tr key={l.id} className="bg-slate-50/60 border-t border-slate-100 text-xs">
                        <td></td>
                        <td className="px-3 py-1.5 text-slate-400">{l.sku || "-"}</td>
                        <td className="px-3 py-1.5" colSpan={2}>{l.display_name}</td>
                        <td></td>
                        <td className="px-3 py-1.5">{l.qty}</td>
                        <td className={`px-3 py-1.5 ${d ? "text-red-600 font-medium" : ""}`}>
                          {l.received_qty ?? "-"}
                          {d ? ` (${d > 0 ? "+" : ""}${d})` : ""}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusColor[l.status]}`}>
                            {t(`transferIn_status_${l.status}` as any)}
                          </span>
                          {l.discrepancy_note && (
                            <div className="text-[10px] text-red-600 mt-0.5">{l.discrepancy_note}</div>
                          )}
                        </td>
                        <td colSpan={2} className="px-3 py-1.5 text-right">
                          {(l as any).photo_url && (
                            <button
                              onClick={async () => setPhotoLink(await getTransferPhotoUrl((l as any).photo_url))}
                              className="text-[10px] text-blue-600 font-medium">
                              📎 {t("transferIn_viewPhoto")}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {!loading && groups.length === 0 && (
              <tr><td colSpan={10} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmGroup && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 print:hidden">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-lg max-h-[85vh] overflow-y-auto">
            <h3 className="font-semibold text-lg mb-1">{t("transferIn_confirm")}</h3>
            <p className="text-sm text-slate-500 mb-4 font-mono">{confirmGroup.ref}</p>

            <table className="w-full text-sm mb-4">
              <thead className="text-slate-500 text-xs">
                <tr>
                  <th className="text-left py-1">{t("stockIn_product")}</th>
                  <th className="text-right py-1 w-16">{t("transferIn_sent")}</th>
                  <th className="text-right py-1 w-24">{t("transferIn_actual")}</th>
                </tr>
              </thead>
              <tbody>
                {confirmGroup.lines.map((l) => {
                  const n = Number(counts[l.id]);
                  const short = !isNaN(n) && n !== l.qty;
                  return (
                    <tr key={l.id} className="border-t border-slate-100">
                      <td className="py-1.5">
                        {l.display_name}
                        <div className="text-[10px] text-slate-400">{l.sku || ""}</div>
                      </td>
                      <td className="py-1.5 text-right">{l.qty}</td>
                      <td className="py-1.5 text-right">
                        <input type="number" min={0}
                          className={`w-20 border rounded-lg px-2 py-1 text-sm text-right ${
                            short ? "border-red-300 bg-red-50" : "border-slate-200"}`}
                          value={counts[l.id] ?? ""}
                          onChange={(e) => setCounts((p) => ({ ...p, [l.id]: e.target.value }))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {confirmGroup.lines.some((l) => Number(counts[l.id]) !== l.qty) && (
              <>
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 mb-3">
                  ⚠️ {t("transferIn_mismatchWarning")}
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
              <button onClick={() => setConfirmGroup(null)}
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
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 print:hidden"
          onClick={() => setPhotoLink(null)}>
          <img src={photoLink} alt="" className="max-h-[80vh] max-w-full rounded-lg" />
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center print:hidden">
          {toast}
        </div>
      )}
    </div>
  );
}
