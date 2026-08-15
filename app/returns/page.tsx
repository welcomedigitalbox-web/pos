"use client";

import { useEffect, useState } from "react";
import {
  supabase, SaleReturn, RefundMethod, ItemCondition,
  netLineTotal, uploadReturnVoucher, getVoucherUrl, upsertStoreInventory, logActivity,
} from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type OrderItem = {
  id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  line_cogs: number;
  alreadyReturned: number;
  netUnitPrice: number;
};

type DraftLine = { qty: string; condition: ItemCondition };

const statusColor: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

export default function ReturnsPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  // create flow
  const [showCreate, setShowCreate] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [foundSale, setFoundSale] = useState<any | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");
  const [reason, setReason] = useState("");
  const [voucherFile, setVoucherFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // approval
  const [reviewRow, setReviewRow] = useState<SaleReturn | null>(null);
  const [reviewItems, setReviewItems] = useState<any[]>([]);
  const [voucherLink, setVoucherLink] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [processing, setProcessing] = useState(false);
  const [approvalPin, setApprovalPin] = useState("");
  const [verifying, setVerifying] = useState(false);

  const canApprove =
    profile?.role === "sale_manager" || profile?.role === "owner" || profile?.role === "admin";

  useEffect(() => {
    if (profile && !hasPermission(profile, "returns")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "returns")) return null;

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("sale_returns")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(100);
    setReturns((data as SaleReturn[]) || []);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  async function findOrder() {
    const q = orderSearch.trim().toLowerCase();
    if (!q) return;

    const { data: sales } = await supabase
      .from("sales")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(300);

    const sale = ((sales as any[]) || []).find(
      (s) => s.id.toLowerCase().includes(q) || s.id.slice(0, 8).toLowerCase() === q
    );
    if (!sale) {
      setFoundSale(null);
      setOrderItems([]);
      return showToast(t("returns_orderNotFound"));
    }

    const { data: items } = await supabase.from("sale_items").select("*").eq("sale_id", sale.id);

    // Anything already returned can't be returned twice
    const { data: prevReturns } = await supabase
      .from("sale_returns")
      .select("id, status, sale_return_items(product_id, variant_id, qty)")
      .eq("original_sale_id", sale.id)
      .neq("status", "rejected");

    const returnedMap = new Map<string, number>();
    for (const r of (prevReturns as any[]) || []) {
      for (const ri of r.sale_return_items || []) {
        const k = `${ri.product_id}:${ri.variant_id || "base"}`;
        returnedMap.set(k, (returnedMap.get(k) || 0) + Number(ri.qty));
      }
    }

    setFoundSale(sale);
    setOrderItems(
      ((items as any[]) || []).map((i) => {
        const net = netLineTotal(i.line_total, sale.subtotal, sale.discount_amount);
        return {
          ...i,
          alreadyReturned: returnedMap.get(`${i.product_id}:${i.variant_id || "base"}`) || 0,
          // Refund what was actually paid per unit, not the pre-discount price
          netUnitPrice: Number(i.qty) > 0 ? net / Number(i.qty) : 0,
        };
      })
    );
    setDraft({});
  }

  const refundTotal = orderItems.reduce((sum, i) => {
    const q = Number(draft[i.id]?.qty || 0);
    return sum + q * i.netUnitPrice;
  }, 0);

  async function submitReturn() {
    const lines = orderItems
      .map((i) => ({ item: i, qty: Number(draft[i.id]?.qty || 0), condition: draft[i.id]?.condition || "good" }))
      .filter((l) => l.qty > 0);

    if (!lines.length) return showToast(t("returns_selectItems"));
    for (const l of lines) {
      if (l.qty > l.item.qty - l.item.alreadyReturned) {
        return showToast(`${t("returns_qtyTooHigh")} — ${l.item.product_name}`);
      }
    }

    setSaving(true);
    try {
      const returnNumber = `RT-${Date.now().toString().slice(-8)}`;
      const { data: created, error } = await supabase
        .from("sale_returns")
        .insert({
          return_number: returnNumber,
          original_sale_id: foundSale.id,
          store_id: storeId,
          customer_id: foundSale.customer_id,
          customer_name: foundSale.customer_name,
          refund_method: refundMethod,
          refund_amount: refundTotal,
          reason: reason.trim() || null,
          requested_by: profile?.email || null,
        })
        .select()
        .single();
      if (error) throw error;

      await supabase.from("sale_return_items").insert(
        lines.map((l) => ({
          return_id: created.id,
          product_id: l.item.product_id,
          variant_id: l.item.variant_id,
          product_name: l.item.product_name,
          qty: l.qty,
          unit_price: l.item.netUnitPrice,
          unit_cogs: Number(l.item.qty) > 0 ? Number(l.item.line_cogs) / Number(l.item.qty) : 0,
          condition: l.condition,
        }))
      );

      if (voucherFile) {
        const path = await uploadReturnVoucher(voucherFile, storeId, created.id);
        await supabase.from("sale_returns").update({ voucher_url: path }).eq("id", created.id);
      }

      await logActivity({
        entityType: "sale_return",
        entityId: created.id,
        action: "requested",
        detail: `${returnNumber} · ${fmt(refundTotal)} · ${lines.length} item(s)`,
        actor: profile?.email,
      });

      showToast(t("returns_submitted"));
      setShowCreate(false);
      setFoundSale(null);
      setOrderItems([]);
      setDraft({});
      setVoucherFile(null);
      setReason("");
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function openReview(r: SaleReturn) {
    setReviewRow(r);
    setRejectReason("");
    setVoucherLink(r.voucher_url ? await getVoucherUrl(r.voucher_url) : null);
    const { data } = await supabase.from("sale_return_items").select("*").eq("return_id", r.id);
    setReviewItems((data as any[]) || []);
  }

  async function approveReturn(approver?: string) {
    if (!reviewRow) return;
    const approvedBy = approver || profile?.email || null;
    setProcessing(true);
    try {
      for (const item of reviewItems) {
        if (item.condition === "good") {
          // Sellable again — put it back on the shelf at its original cost
          const { data: inv } = await (item.variant_id
            ? supabase.from("store_inventory").select("*").eq("store_id", reviewRow.store_id)
                .eq("product_id", item.product_id).eq("variant_id", item.variant_id).maybeSingle()
            : supabase.from("store_inventory").select("*").eq("store_id", reviewRow.store_id)
                .eq("product_id", item.product_id).is("variant_id", null).maybeSingle());

          await upsertStoreInventory(reviewRow.store_id, item.product_id, item.variant_id, {
            stock_qty: Number(inv?.stock_qty || 0) + Number(item.qty),
          });
        } else {
          // Damaged goods never re-enter sellable stock; log them as a write-off
          await supabase.from("stock_damages").insert({
            store_id: reviewRow.store_id,
            product_id: item.product_id,
            variant_id: item.variant_id,
            qty: item.qty,
            reason: `Return ${reviewRow.return_number}`,
            reported_by: profile?.email || null,
          });
        }
      }

      if (reviewRow.refund_method === "store_credit" && reviewRow.customer_id) {
        const { data: cust } = await supabase
          .from("customers").select("store_credit").eq("id", reviewRow.customer_id).maybeSingle();
        await supabase
          .from("customers")
          .update({ store_credit: Number(cust?.store_credit || 0) + Number(reviewRow.refund_amount) })
          .eq("id", reviewRow.customer_id);
      }

      await supabase
        .from("sale_returns")
        .update({ status: "approved", approved_by: approvedBy, approved_at: new Date().toISOString() })
        .eq("id", reviewRow.id);

      await logActivity({
        entityType: "sale_return",
        entityId: reviewRow.id,
        action: "approved",
        detail: `${reviewRow.return_number} · ${fmt(Number(reviewRow.refund_amount))}`,
        actor: approvedBy,
      });

      showToast(t("returns_approved"));
      setReviewRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setProcessing(false);
    }
  }

  async function approveWithPin() {
    if (!approvalPin.trim()) return showToast(t("returns_pinRequired"));
    setVerifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-discount-approver", {
        body: { pin: approvalPin.trim() },
      });
      if (error) throw error;
      if (!data?.approved) {
        showToast("❌ " + (data?.error || t("returns_pinInvalid")));
        return;
      }
      setApprovalPin("");
      await approveReturn(data.approver_email);
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setVerifying(false);
    }
  }

  async function rejectReturn() {
    if (!reviewRow || !rejectReason.trim()) return showToast(t("returns_rejectReasonRequired"));
    await supabase
      .from("sale_returns")
      .update({ status: "rejected", approved_by: profile?.email || null, rejected_reason: rejectReason.trim() })
      .eq("id", reviewRow.id);
    await logActivity({
      entityType: "sale_return", entityId: reviewRow.id, action: "rejected",
      detail: rejectReason.trim(), actor: profile?.email,
    });
    showToast(t("returns_rejected"));
    setReviewRow(null);
    await load();
  }

  const pending = returns.filter((r) => r.status === "pending").length;

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_returns")}</h2>
        <button onClick={() => setShowCreate(true)}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("returns_new")}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        {t("returns_pending")}: <span className="font-semibold text-orange-600">{pending}</span>
      </p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("returns_number")}</th>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("pos_customer")}</th>
              <th className="text-left px-3 py-2">{t("returns_refundMethod")}</th>
              <th className="text-left px-3 py-2">{t("returns_refundAmount")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2">{t("returns_requestedBy")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && returns.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-xs">{r.return_number}</td>
                <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">{r.customer_name || "-"}</td>
                <td className="px-3 py-2 text-xs">{t(`returns_method_${r.refund_method}` as any)}</td>
                <td className="px-3 py-2 font-medium">{fmt(Number(r.refund_amount))}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status]}`}>
                    {t(`returns_status_${r.status}` as any)}
                  </span>
                  {r.rejected_reason && (
                    <div className="text-[10px] text-red-600 mt-0.5">{r.rejected_reason}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">{r.requested_by || "-"}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => openReview(r)} className="text-blue-600 text-xs font-medium">
                    {r.status === "pending" ? t("returns_review") : t("products_view")}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && returns.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-4">{t("returns_new")}</h3>

            <label className="text-sm text-slate-600">{t("orderLookup_orderId")}</label>
            <div className="flex gap-2 mt-1 mb-4">
              <input className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="A1B2C3D4"
                onKeyDown={(e) => e.key === "Enter" && findOrder()} />
              <button onClick={findOrder} className="px-4 py-2 bg-slate-700 text-white rounded-lg text-sm font-medium">
                {t("returns_findOrder")}
              </button>
            </div>

            {foundSale && (
              <>
                <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs text-slate-600 mb-3">
                  {new Date(foundSale.created_at).toLocaleString()} · {foundSale.customer_name || "-"} ·{" "}
                  {t("pos_total")}: {fmt(foundSale.total)}
                </div>

                <div className="border border-slate-200 rounded-lg overflow-x-auto mb-3">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                        <th className="text-left px-3 py-2">{t("returns_bought")}</th>
                        <th className="text-left px-3 py-2">{t("returns_returnQty")}</th>
                        <th className="text-left px-3 py-2">{t("returns_condition")}</th>
                        <th className="text-left px-3 py-2">{t("returns_refundAmount")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderItems.map((i) => {
                        const remaining = i.qty - i.alreadyReturned;
                        const q = Number(draft[i.id]?.qty || 0);
                        return (
                          <tr key={i.id} className="border-t border-slate-100">
                            <td className="px-3 py-2">{i.product_name}</td>
                            <td className="px-3 py-2">
                              {i.qty}
                              {i.alreadyReturned > 0 && (
                                <span className="text-[10px] text-orange-600 ml-1">
                                  ({t("returns_alreadyReturned")} {i.alreadyReturned})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" min={0} max={remaining} disabled={remaining <= 0}
                                className="w-20 border border-slate-200 rounded px-2 py-1 text-sm disabled:bg-slate-100"
                                value={draft[i.id]?.qty || ""}
                                onChange={(e) =>
                                  setDraft({ ...draft, [i.id]: { qty: e.target.value, condition: draft[i.id]?.condition || "good" } })
                                } />
                            </td>
                            <td className="px-3 py-2">
                              <select className="border border-slate-200 rounded px-2 py-1 text-xs"
                                value={draft[i.id]?.condition || "good"}
                                onChange={(e) =>
                                  setDraft({ ...draft, [i.id]: { qty: draft[i.id]?.qty || "", condition: e.target.value as ItemCondition } })
                                }>
                                <option value="good">{t("returns_conditionGood")}</option>
                                <option value="damaged">{t("returns_conditionDamaged")}</option>
                              </select>
                            </td>
                            <td className="px-3 py-2 font-medium">{fmt(q * i.netUnitPrice)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="text-sm text-slate-600">{t("returns_refundMethod")}</label>
                    <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                      value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as RefundMethod)}>
                      <option value="cash">{t("returns_method_cash")}</option>
                      <option value="exchange">{t("returns_method_exchange")}</option>
                      <option value="store_credit">{t("returns_method_store_credit")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-slate-600">{t("returns_voucher")}</label>
                    <input type="file" accept="image/*"
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs mt-1"
                      onChange={(e) => setVoucherFile(e.target.files?.[0] || null)} />
                  </div>
                </div>

                <label className="text-sm text-slate-600">{t("returns_reason")}</label>
                <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" rows={2}
                  value={reason} onChange={(e) => setReason(e.target.value)} />

                <div className="flex justify-between items-center font-bold mb-4 border-t border-slate-200 pt-3">
                  <span>{t("returns_refundAmount")}</span>
                  <span>{fmt(refundTotal)}</span>
                </div>
              </>
            )}

            <div className="flex gap-2">
              <button onClick={() => { setShowCreate(false); setFoundSale(null); setOrderItems([]); }}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitReturn} disabled={saving || !foundSale || refundTotal <= 0}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("returns_submit")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review */}
      {reviewRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-1 font-mono">{reviewRow.return_number}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {reviewRow.customer_name || "-"} · {t(`returns_method_${reviewRow.refund_method}` as any)} ·{" "}
              {fmt(Number(reviewRow.refund_amount))}
            </p>

            <div className="border border-slate-200 rounded-lg overflow-hidden mb-3">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                    <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                    <th className="text-left px-3 py-2">{t("returns_condition")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewItems.map((i) => (
                    <tr key={i.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{i.product_name}</td>
                      <td className="px-3 py-2">{i.qty}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          i.condition === "good" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                        }`}>
                          {t(i.condition === "good" ? "returns_conditionGood" : "returns_conditionDamaged")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {reviewRow.reason && (
              <p className="text-sm text-slate-600 mb-3">
                <span className="text-xs text-slate-400 uppercase">{t("returns_reason")}</span><br />
                {reviewRow.reason}
              </p>
            )}

            {voucherLink && (
              <a href={voucherLink} target="_blank" rel="noreferrer"
                className="block mb-3 text-sm text-blue-600 font-medium">
                📎 {t("returns_viewVoucher")}
              </a>
            )}

            {reviewRow.status === "pending" && !canApprove && (
              <>
                <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-3">
                  {t("returns_pinHint")}
                </p>
                <label className="text-sm text-slate-600">{t("returns_managerPin")}</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3 tracking-widest text-center"
                  placeholder="••••"
                  value={approvalPin}
                  onChange={(e) => setApprovalPin(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && approveWithPin()}
                />
                <div className="flex gap-2">
                  <button onClick={() => setReviewRow(null)}
                    className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                    {t("products_cancel")}
                  </button>
                  <button onClick={approveWithPin} disabled={verifying || processing}
                    className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                    {verifying || processing ? "..." : t("returns_approveWithPin")}
                  </button>
                </div>
              </>
            )}

            {reviewRow.status === "pending" && canApprove ? (
              <>
                <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-3">
                  {t("returns_approveHint")}
                </p>
                <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
                  placeholder={t("returns_rejectReason")}
                  value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                <div className="flex gap-2">
                  <button onClick={rejectReturn} disabled={processing}
                    className="flex-1 py-2.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium">
                    {t("returns_reject")}
                  </button>
                  <button onClick={() => approveReturn()} disabled={processing}
                    className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                    {processing ? "..." : t("returns_approve")}
                  </button>
                </div>
              </>
            ) : reviewRow.status !== "pending" ? (
              <button onClick={() => setReviewRow(null)}
                className="w-full py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
            ) : null}
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
