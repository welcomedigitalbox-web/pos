"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  supabase, SellableItem, PurchaseOrder, PurchaseOrderItem, PoPayment, PoStatus,
  CENTRAL_WAREHOUSE_ID, ActivityLog, fetchSellableItems, receivePoItem, logActivity,
} from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useLanguage } from "../../language-context";
import { hasPermission } from "../../permissions";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type ItemRow = PurchaseOrderItem & { display_name: string; is_consignment: boolean; requires_expiry: boolean };

export default function PoDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { profile } = useAuth();
  const { t } = useLanguage();

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [supplierName, setSupplierName] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [payments, setPayments] = useState<PoPayment[]>([]);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [sellables, setSellables] = useState<SellableItem[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [toast, setToast] = useState("");

  // add-item form
  const [itemKey, setItemKey] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [updateCost, setUpdateCost] = useState(false);

  // receive modal
  const [receiveRow, setReceiveRow] = useState<ItemRow | null>(null);
  const [receiveQty, setReceiveQty] = useState("");
  const [receiveCost, setReceiveCost] = useState("");
  const [receiveExpiry, setReceiveExpiry] = useState("");
  const [receiving, setReceiving] = useState(false);

  // payment modal
  const [showPayment, setShowPayment] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [payNote, setPayNote] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "purchase-orders")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!profile || !hasPermission(profile, "purchase-orders")) return null;

  async function load() {
    const { data: poData } = await supabase
      .from("purchase_orders")
      .select("*, suppliers(name)")
      .eq("id", id)
      .maybeSingle();
    if (!poData) {
      setNotFound(true);
      return;
    }
    setPo(poData as PurchaseOrder);
    setSupplierName((poData as any).suppliers?.name || "-");

    const all = await fetchSellableItems(CENTRAL_WAREHOUSE_ID, true);
    setSellables(all);

    const { data: itemData } = await supabase
      .from("purchase_order_items")
      .select("*, products(name, is_consignment, requires_expiry), product_variants(variant_name)")
      .eq("po_id", id)
      .order("created_at");

    setItems(
      ((itemData as any[]) || []).map((i) => ({
        ...i,
        display_name: i.product_variants?.variant_name
          ? `${i.products?.name} (${i.product_variants.variant_name})`
          : i.products?.name || "-",
        is_consignment: !!i.products?.is_consignment,
        requires_expiry: !!i.products?.requires_expiry,
      }))
    );

    const { data: receiptData } = await supabase
      .from("stock_purchases")
      .select("*, products(name), product_variants(variant_name)")
      .eq("po_id", id)
      .order("received_at", { ascending: false });
    setReceipts(
      ((receiptData as any[]) || []).map((r) => ({
        ...r,
        display_name: r.product_variants?.variant_name
          ? `${r.products?.name} (${r.product_variants.variant_name})`
          : r.products?.name || "-",
      }))
    );

    const { data: logData } = await supabase
      .from("activity_log")
      .select("*")
      .eq("entity_type", "purchase_order")
      .eq("entity_id", id)
      .order("created_at", { ascending: false });
    setLogs((logData as ActivityLog[]) || []);

    const { data: payData } = await supabase
      .from("po_payments")
      .select("*")
      .eq("po_id", id)
      .order("paid_at", { ascending: false });
    setPayments((payData as PoPayment[]) || []);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function refreshStatus(nextItems: ItemRow[]) {
    const anyReceived = nextItems.some((i) => i.received_qty > 0);
    const allReceived = nextItems.length > 0 && nextItems.every((i) => i.received_qty >= i.qty);
    const status: PoStatus = allReceived ? "received" : anyReceived ? "partial" : po?.status === "draft" ? "draft" : "ordered";
    await supabase.from("purchase_orders").update({ status }).eq("id", id);
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const sel = sellables.find((s) => s.key === itemKey);
    const qtyNum = Number(qty);
    const costNum = Number(unitCost);
    if (!sel) return showToast(t("stockIn_selectProduct"));
    if (!qtyNum || qtyNum <= 0) return showToast(t("stockRequest_qtyInvalid"));

    const { error } = await supabase.from("purchase_order_items").insert({
      po_id: id,
      product_id: sel.product_id,
      variant_id: sel.variant_id,
      qty: qtyNum,
      unit_cost: isNaN(costNum) ? 0 : costNum,
      update_cost: updateCost,
    });
    if (error) return showToast("❌ " + error.message);
    await logActivity({
      entityType: "purchase_order",
      entityId: id,
      action: "item_added",
      detail: `${sel.display_name} × ${qtyNum} @ ${costNum || 0}`,
      actor: profile?.email,
    });
    setItemKey("");
    setQty("");
    setUnitCost("");
    setUpdateCost(false);
    await load();
  }

  async function deleteItem(itemId: string) {
    await supabase.from("purchase_order_items").delete().eq("id", itemId);
    await load();
  }

  function openReceive(row: ItemRow) {
    setReceiveRow(row);
    setReceiveQty(String(row.qty - row.received_qty));
    setReceiveCost(String(row.unit_cost));
    setReceiveExpiry("");
  }

  async function submitReceive() {
    if (!receiveRow) return;
    const q = Number(receiveQty);
    const c = Number(receiveCost);
    if (!q || q <= 0) return showToast(t("stockRequest_qtyInvalid"));
    if (isNaN(c) || c < 0) return showToast(t("stockIn_costInvalid"));
    if (receiveRow.requires_expiry && !receiveExpiry) return showToast(t("po_expiryRequired"));

    setReceiving(true);
    try {
      // Goods are received into the central pool; Warehouse distributes from there
      await receivePoItem({
        storeId: CENTRAL_WAREHOUSE_ID,
        productId: receiveRow.product_id,
        variantId: receiveRow.variant_id,
        qty: q,
        unitCost: c,
        updateCost: receiveRow.update_cost,
        isConsignment: receiveRow.is_consignment,
        poId: id,
        supplier: supplierName,
        expiryDate: receiveExpiry || null,
        requiresExpiry: receiveRow.requires_expiry,
        receivedBy: profile?.email || null,
      });

      const newReceived = receiveRow.received_qty + q;
      await supabase
        .from("purchase_order_items")
        .update({ received_qty: newReceived, unit_cost: c })
        .eq("id", receiveRow.id);

      const nextItems = items.map((i) =>
        i.id === receiveRow.id ? { ...i, received_qty: newReceived } : i
      );
      await refreshStatus(nextItems);

      await logActivity({
        entityType: "purchase_order",
        entityId: id,
        action: "received",
        detail: `${receiveRow.display_name} × ${q} @ ${c}${receiveExpiry ? ` (exp ${receiveExpiry})` : ""}`,
        actor: profile?.email,
      });
      showToast(t("po_received"));
      setReceiveRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setReceiving(false);
    }
  }

  async function cancelPo() {
    if (!confirm(t("po_cancelConfirm"))) return;
    const { error } = await supabase.from("purchase_orders").update({ status: "cancelled" }).eq("id", id);
    if (error) return showToast("❌ " + error.message);
    await logActivity({
      entityType: "purchase_order",
      entityId: id,
      action: "cancelled",
      actor: profile?.email,
    });
    showToast(t("po_cancelled"));
    await load();
  }

  async function reopenPo() {
    const { error } = await supabase.from("purchase_orders").update({ status: "ordered" }).eq("id", id);
    if (error) return showToast("❌ " + error.message);
    await logActivity({
      entityType: "purchase_order",
      entityId: id,
      action: "reopened",
      actor: profile?.email,
    });
    showToast(t("po_reopened"));
    await load();
  }

  async function deletePo() {
    if (!confirm(t("po_deleteConfirm"))) return;
    const { error } = await supabase.from("purchase_orders").delete().eq("id", id);
    if (error) return showToast("❌ " + error.message);
    router.push("/purchase-orders");
  }

  async function addPayment(e: React.FormEvent) {
    e.preventDefault();
    const amt = Number(payAmount);
    if (!amt || amt <= 0) return showToast(t("stockRequest_qtyInvalid"));
    const { error } = await supabase.from("po_payments").insert({
      po_id: id,
      amount: amt,
      method: payMethod.trim() || null,
      note: payNote.trim() || null,
      paid_by: profile?.email || null,
    });
    if (error) return showToast("❌ " + error.message);
    await logActivity({
      entityType: "purchase_order",
      entityId: id,
      action: "payment_added",
      detail: `${amt.toLocaleString()} MMK${payMethod.trim() ? ` · ${payMethod.trim()}` : ""}`,
      actor: profile?.email,
    });
    showToast(t("po_paymentAdded"));
    setShowPayment(false);
    setPayAmount("");
    setPayMethod("");
    setPayNote("");
    await load();
  }

  if (notFound) return <div className="pt-8 text-center text-slate-400">{t("products_notFound")}</div>;
  if (!po) return <div className="pt-8 text-center text-slate-400">...</div>;

  const total = items.reduce((s, i) => s + i.qty * i.unit_cost, 0);
  const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = total - paid;
  const editable = po.status !== "received" && po.status !== "cancelled";

  return (
    <div className="pt-4 max-w-5xl">
      <Link href="/purchase-orders" className="text-sm text-blue-600 mb-2 inline-block">
        ← {t("nav_purchaseOrders")}
      </Link>

      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h1 className="text-xl font-bold">{po.po_number}</h1>
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
          {t(`po_status_${po.status}` as any)}
        </span>
        <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
          {t(`po_term_${po.payment_term}` as any)}
        </span>
      </div>
      <div className="text-slate-400 text-sm mb-3">
        {supplierName} · {po.order_date}
        {po.expected_date && ` · ${t("po_expectedDate")}: ${po.expected_date}`}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {po.status !== "cancelled" && po.status !== "received" && (
          <button onClick={cancelPo}
            className="px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs font-medium">
            {t("po_cancel")}
          </button>
        )}
        {po.status === "cancelled" && (
          <>
            <button onClick={reopenPo}
              className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-xs font-medium">
              {t("po_reopen")}
            </button>
            {receipts.length === 0 && (
              <button onClick={deletePo}
                className="px-3 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs font-medium">
                {t("po_delete")}
              </button>
            )}
          </>
        )}
        <span className="text-xs text-slate-400 self-center ml-1">{t("po_autoSaveNote")}</span>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("pos_total")}</div>
          <div className="text-lg font-bold mt-1">{fmt(total)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("suppliers_paid")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{fmt(paid)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("po_balance")}</div>
          <div className={`text-lg font-bold mt-1 ${balance > 0 ? "text-orange-600" : "text-green-700"}`}>
            {fmt(balance)}
          </div>
        </div>
      </div>

      {/* Items */}
      <h3 className="font-semibold mb-2">{t("po_items")}</h3>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-3">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
              <th className="text-left px-3 py-2">{t("po_orderQty")}</th>
              <th className="text-left px-3 py-2">{t("stockIn_unitCost")}</th>
              <th className="text-left px-3 py-2">{t("pos_total")}</th>
              <th className="text-left px-3 py-2">{t("po_receivedQty")}</th>
              <th className="text-left px-3 py-2">{t("po_updateCost")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const done = i.received_qty >= i.qty;
              return (
                <tr key={i.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    {i.display_name}
                    {i.is_consignment && (
                      <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                        {t("po_consignment")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{i.qty}</td>
                  <td className="px-3 py-2">{fmt(i.unit_cost)}</td>
                  <td className="px-3 py-2 font-medium">{fmt(i.qty * i.unit_cost)}</td>
                  <td className={`px-3 py-2 font-medium ${done ? "text-green-700" : "text-orange-600"}`}>
                    {i.received_qty} / {i.qty}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {i.is_consignment ? "—" : i.update_cost ? "✅" : "-"}
                  </td>
                  <td className="px-3 py-2 text-right space-x-2">
                    {!done && (
                      <button onClick={() => openReceive(i)} className="text-blue-600 text-xs font-medium">
                        {t("po_receive")}
                      </button>
                    )}
                    {editable && i.received_qty === 0 && (
                      <button onClick={() => deleteItem(i.id)} className="text-red-600 text-xs font-medium">
                        {t("products_delete")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-6">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add item */}
      {editable && (
        <form onSubmit={addItem} className="bg-white border border-slate-200 rounded-xl p-3 mb-6">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="w-44">
              <label className="text-xs text-slate-500">{t("po_scanBarcode")}</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                value={barcodeInput}
                placeholder={t("po_scanBarcodePlaceholder")}
                onChange={(e) => {
                  const v = e.target.value;
                  setBarcodeInput(v);
                  // Scanner types the whole code then stops — match on exact SKU
                  const hit = sellables.find(
                    (s) => (s.sku || "").toLowerCase() === v.trim().toLowerCase() && v.trim() !== ""
                  );
                  if (hit) {
                    setItemKey(hit.key);
                    setBarcodeInput("");
                    showToast(`✅ ${hit.display_name}`);
                  }
                }}
              />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-slate-500">{t("stockIn_product")}</label>
              <select className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                value={itemKey} onChange={(e) => setItemKey(e.target.value)} required>
                <option value="">{t("stockIn_selectPlaceholder")}</option>
                {sellables.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.display_name}{s.sku ? ` · ${s.sku}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-24">
              <label className="text-xs text-slate-500">{t("po_orderQty")}</label>
              <input type="number" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                value={qty} onChange={(e) => setQty(e.target.value)} required />
            </div>
            <div className="w-28">
              <label className="text-xs text-slate-500">{t("stockIn_unitCost")}</label>
              <input type="number" className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1"
                value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
            </div>
            <label className="flex items-center gap-1.5 text-xs pb-2">
              <input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} />
              {t("po_updateCost")}
            </label>
            <button type="submit" className="px-4 py-2 bg-slate-700 text-white rounded-lg text-sm font-medium">
              {t("po_addItem")}
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2">{t("po_updateCostHint")}</p>
        </form>
      )}

      {/* Receipt history */}
      {receipts.length > 0 && (
        <>
          <h3 className="font-semibold mb-2">{t("po_receiptHistory")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[620px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("ledger_date")}</th>
                  <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                  <th className="text-left px-3 py-2">{t("po_receivedQty")}</th>
                  <th className="text-left px-3 py-2">{t("stockIn_unitCost")}</th>
                  <th className="text-left px-3 py-2">{t("stockIn_expiryDate")}</th>
                  <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{new Date(r.received_at || r.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{r.display_name}</td>
                    <td className="px-3 py-2 font-medium">{r.qty}</td>
                    <td className="px-3 py-2">{fmt(Number(r.unit_cost))}</td>
                    <td className="px-3 py-2 text-slate-400">{r.expiry_date || "-"}</td>
                    <td className="px-3 py-2 text-slate-500 text-xs">{r.received_by || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Payments */}
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-semibold">{t("po_payments")}</h3>
        <button onClick={() => setShowPayment(true)}
          className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium">
          {t("po_addPayment")}
        </button>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("ledger_date")}</th>
              <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
              <th className="text-left px-3 py-2">{t("pos_paymentMethod")}</th>
              <th className="text-left px-3 py-2">{t("pos_note")}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{p.paid_at}</td>
                <td className="px-3 py-2 font-medium text-green-700">{fmt(Number(p.amount))}</td>
                <td className="px-3 py-2 text-slate-400">{p.method || "-"}</td>
                <td className="px-3 py-2 text-slate-400">{p.note || "-"}</td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-400 py-6">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Activity log */}
      <h3 className="font-semibold mt-6 mb-2">{t("po_activityLog")}</h3>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("ledger_date")}</th>
              <th className="text-left px-3 py-2">{t("po_logAction")}</th>
              <th className="text-left px-3 py-2">{t("po_logDetail")}</th>
              <th className="text-left px-3 py-2">{t("po_logActor")}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-500">{new Date(l.created_at).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                    {t(`po_log_${l.action}` as any)}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-500">{l.detail || "-"}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{l.actor || "-"}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-400 py-6">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Receive modal */}
      {receiveRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("po_receive")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {receiveRow.display_name} · {t("po_remaining")}: {receiveRow.qty - receiveRow.received_qty}
            </p>

            <label className="text-sm text-slate-600">{t("po_receivedQty")}</label>
            <input type="number" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={receiveQty} onChange={(e) => setReceiveQty(e.target.value)} />

            <label className="text-sm text-slate-600">{t("stockIn_unitCost")}</label>
            <input type="number" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={receiveCost} onChange={(e) => setReceiveCost(e.target.value)} />

            <label className="text-sm text-slate-600">
              {t("stockIn_expiryDate")}
              {receiveRow.requires_expiry && <span className="text-red-600"> *</span>}
            </label>
            <input
              type="date"
              className={`w-full border rounded-lg px-3 py-2 text-sm mt-1 mb-3 ${
                receiveRow.requires_expiry && !receiveExpiry ? "border-red-300 bg-red-50" : "border-slate-200"
              }`}
              value={receiveExpiry}
              onChange={(e) => setReceiveExpiry(e.target.value)}
              required={receiveRow.requires_expiry}
            />

            <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-4">
              {receiveRow.is_consignment
                ? t("po_costRuleConsignment")
                : receiveRow.update_cost
                ? t("po_costRuleLatest")
                : t("po_costRuleAverage")}
            </p>

            <div className="flex gap-2">
              <button onClick={() => setReceiveRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitReceive} disabled={receiving || (receiveRow.requires_expiry && !receiveExpiry)}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {receiving ? "..." : t("po_receive")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment modal */}
      {showPayment && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={addPayment} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("po_addPayment")}</h3>
            <p className="text-sm text-slate-500 mb-4">{t("po_balance")}: {fmt(balance)}</p>

            <label className="text-sm text-slate-600">{t("mySales_amount")}</label>
            <input type="number" autoFocus className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={payAmount} onChange={(e) => setPayAmount(e.target.value)} required />

            <label className="text-sm text-slate-600">{t("pos_paymentMethod")}</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={payMethod} onChange={(e) => setPayMethod(e.target.value)} placeholder="Cash / Bank" />

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4" rows={2}
              value={payNote} onChange={(e) => setPayNote(e.target.value)} />

            <div className="flex gap-2">
              <button type="button" onClick={() => setShowPayment(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button type="submit" className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold">
                {t("products_save")}
              </button>
            </div>
          </form>
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
