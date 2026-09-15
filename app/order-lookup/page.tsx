"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import Receipt, { ReceiptData } from "../receipt";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";
import type { TranslationKey } from "../i18n";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type OrderItem = {
  id: string;
  product_name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  line_cogs: number;
};

type Order = {
  id: string;
  sale_ref: string | null;
  created_at: string;
  store_id: string;
  order_type: string;
  order_status: string;
  channel: string | null;
  customer_name: string | null;
  cashier_email: string | null;
  sale_rep_name: string | null;
  payment_method: string | null;
  subtotal: number;
  discount_type: string | null;
  discount_value: number;
  discount_amount: number;
  discount_approved_by: string | null;
  vat_amount: number;
  total: number;
  amount_received: number;
  change_amount: number;
  advance_payment: number;
  balance_due: number;
  delivery_address: string | null;
  note: string | null;
};

// Rows from the shared lookup_order function — the shop, the finance app and the
// Messenger CRM all answer the same search, so an online buyer can be found at the till
type LookupRow = {
  source: "pos" | "online";
  id: string;
  reference: string | null;
  occurred_at: string;
  store_id: string | null;
  store_name: string | null;
  customer_name: string | null;
  phone: string | null;
  total: number;
  paid: number;
  balance: number;
  payment_method: string | null;
  payment_status: "paid" | "partial" | "unpaid";
  fulfilment_status: string | null;
  sale_type: "walk_in" | "wholesale" | "online_retail" | "online_wholesale";
  voucher_no: string | null;
  note: string | null;
};

type LookupItem = {
  description: string;
  qty: number;
  unit_price: number;
  line_total: number;
};

const PAY_STATUS_CLASS: Record<LookupRow["payment_status"], string> = {
  paid: "bg-green-100 text-green-700",
  partial: "bg-amber-100 text-amber-700",
  unpaid: "bg-orange-100 text-orange-700",
};

export default function OrderLookupPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [returnedSaleIds, setReturnedSaleIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [returnedItems, setReturnedItems] = useState<any[]>([]);
  const [refundTotal, setRefundTotal] = useState(0);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [printing, setPrinting] = useState(false);
  const [online, setOnline] = useState<LookupRow[]>([]);
  const [lookupError, setLookupError] = useState("");
  const [onlineSelected, setOnlineSelected] = useState<LookupRow | null>(null);
  const [onlineItems, setOnlineItems] = useState<LookupItem[]>([]);
  const [onlineItemsLoading, setOnlineItemsLoading] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "order-lookup")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    const timer = setTimeout(() => {
      load(search);
      loadLookup(search);
    }, search ? 350 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  if (!profile || !hasPermission(profile, "order-lookup")) return null;

  async function load(term = "") {
    setLoading(true);

    // Search hits the database rather than filtering a fixed page of rows —
    // otherwise anything older than the newest 200 orders can never be found.
    let query = supabase
      .from("sales")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(term.trim() ? 100 : 50);

    const q = term.trim();
    if (q) {
      // Staff quote the short reference from the receipt, so match on that too
      const isRef = /^[0-9a-f-]{4,}$/i.test(q);
      query = isRef
        ? query.or(
            `customer_name.ilike.%${q}%,cashier_email.ilike.%${q}%,sale_rep_name.ilike.%${q}%,id.gte.${q}`
          )
        : query.or(
            `customer_name.ilike.%${q}%,cashier_email.ilike.%${q}%,sale_rep_name.ilike.%${q}%`
          );
    }

    const { data } = await query;

    // The short reference is a prefix of the uuid, which Postgres can't match
    // directly, so narrow that last step here
    const rows = ((data as Order[]) || []).filter((o) =>
      q ? o.id.toLowerCase().startsWith(q.toLowerCase()) ||
          (o.customer_name || "").toLowerCase().includes(q.toLowerCase()) ||
          (o.cashier_email || "").toLowerCase().includes(q.toLowerCase()) ||
          (o.sale_rep_name || "").toLowerCase().includes(q.toLowerCase())
        : true
    );
    setOrders(rows);

    const { data: returned } = await supabase
      .from("sale_returns")
      .select("original_sale_id")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(500);
    setReturnedSaleIds(
      new Set(((returned as any[]) || []).map((r) => r.original_sale_id).filter(Boolean))
    );

    setLoading(false);
  }

  // One keystroke searches both sides; the shared function already limits what the
  // caller is allowed to see, so nothing extra is exposed here
  async function loadLookup(term = "") {
    const q = term.trim();
    if (!q) {
      setOnline([]);
      setLookupError("");
      return;
    }

    const { data, error } = await supabase.rpc("lookup_order", { p_query: q, p_limit: 25 });
    if (error) {
      setLookupError(error.message);
      setOnline([]);
      return;
    }
    setLookupError("");
    setOnline(((data as LookupRow[]) || []).filter((r) => r.source === "online"));
  }

  async function openOnline(row: LookupRow) {
    setOnlineSelected(row);
    setOnlineItems([]);
    setOnlineItemsLoading(true);
    const { data, error } = await supabase.rpc("lookup_order_items", {
      p_source: "online",
      p_id: row.id,
    });
    if (error) setLookupError(error.message);
    else setOnlineItems((data as LookupItem[]) || []);
    setOnlineItemsLoading(false);
  }

  function saleTypeLabel(saleType: LookupRow["sale_type"]) {
    return t(`lookup_type_${saleType}` as TranslationKey);
  }

  async function openOrder(o: Order) {
    setSelected(o);
    setItemsLoading(true);
    const { data } = await supabase
      .from("sale_items")
      .select("*")
      .eq("sale_id", o.id)
      .order("created_at");
    setItems((data as OrderItem[]) || []);

    // Approved returns against this order, so the totals below reflect what the
    // shop actually kept rather than what was originally rung up
    const { data: rets } = await supabase
      .from("sale_returns")
      .select("id, refund_amount")
      .eq("original_sale_id", o.id)
      .eq("status", "approved");

    const retIds = ((rets as any[]) || []).map((r) => r.id);
    setRefundTotal(((rets as any[]) || []).reduce((sum, r) => sum + Number(r.refund_amount), 0));

    if (retIds.length) {
      const { data: retItems } = await supabase
        .from("sale_return_items")
        .select("product_id, variant_id, product_name, qty, unit_price, unit_cogs, line_type")
        .in("return_id", retIds)
        .eq("line_type", "return");
      setReturnedItems((retItems as any[]) || []);
    } else {
      setReturnedItems([]);
    }

    setItemsLoading(false);
  }

  async function reprint() {
    if (!selected) return;
    setPrinting(true);
    try {
      const { data: settings } = await supabase
        .from("store_settings")
        .select("*")
        .eq("store_id", selected.store_id)
        .maybeSingle();

      const o = selected as any;
      setReceipt({
        storeId: selected.store_id,
        businessName: settings?.business_name || null,
        phone: settings?.phone || null,
        address: settings?.address || null,
        footerText: settings?.footer_text || null,
        logoText: settings?.logo_text || null,
        saleRef: selected.sale_ref || selected.id.slice(0, 8).toUpperCase(),
        createdAt: selected.created_at,
        items: items.map((i) => ({
          name: i.product_name,
          qty: Number(i.qty),
          price: Number(i.unit_price),
          lineTotal: Number(i.line_total),
        })),
        subtotal: Number(o.subtotal || 0),
        discountLabel: o.discount_type === "percent" ? `${o.discount_value}%` : "",
        discountAmount: Number(o.discount_amount || 0),
        vatPercent: Number(o.vat_percent || 0),
        vatAmount: Number(o.vat_amount || 0),
        grandTotal: Number(o.total || 0),
        paymentMethod: o.payment_method || "",
        amountReceived: Number(o.amount_received || 0),
        change: Number(o.change_amount || 0),
        advancePayment: Number(o.advance_payment || 0),
        balanceDue: Number(o.balance_due || 0),
        note: o.note || "",
        customerName: o.customer_name || "",
        cashierEmail: o.cashier_email || "",
      });

      // Let the receipt mount, then apply the thermal page size for this print only
      setTimeout(() => {
        const style = document.createElement("style");
        style.textContent = "@page { size: 80mm auto; margin: 0; }";
        document.head.appendChild(style);
        window.print();
        setTimeout(() => {
          style.remove();
          setReceipt(null);
          setPrinting(false);
        }, 500);
      }, 300);
    } catch {
      setPrinting(false);
    }
  }

  // Matching on the short reference shown on receipts, plus customer and staff
  const filtered = orders;

  // This order's own discount is already known, so apply it directly
  const grossGp = items.reduce((s, i) => s + (Number(i.line_total) - Number(i.line_cogs || 0)), 0);
  const returnedMargin = returnedItems.reduce(
    (sum, r) => sum + Number(r.qty) * (Number(r.unit_price) - Number(r.unit_cogs)), 0);
  const gp = grossGp - Number(selected?.discount_amount || 0) - returnedMargin;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_orderLookup")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("orderLookup_subtitle")}</p>

      <input
        className="w-full sm:w-[28rem] border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        placeholder={t("orderLookup_searchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <h3 className="font-semibold text-sm mb-2">{t("lookup_posResults")}</h3>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("orderLookup_orderId")}</th>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("admin_store")}</th>
              <th className="text-left px-3 py-2">{t("pos_customer")}</th>
              <th className="text-left px-3 py-2">{t("pos_cashier")}</th>
              <th className="text-left px-3 py-2">{t("pos_salesRep")}</th>
              <th className="text-left px-3 py-2">{t("mySales_amount")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filtered.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-xs">
                  {o.sale_ref || o.id.slice(0, 8).toUpperCase()}
                  {returnedSaleIds.has(o.id) && (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-700 font-medium">
                      {t("returns_returnedBadge")}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{new Date(o.created_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-500">{o.store_id}</td>
                <td className="px-3 py-2">{o.customer_name || "-"}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{o.cashier_email || "-"}</td>
                <td className="px-3 py-2 text-slate-500">{o.sale_rep_name || "-"}</td>
                <td className="px-3 py-2 font-medium">{fmt(o.total)}</td>
                <td className="px-3 py-2 text-xs">{o.order_status}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => openOrder(o)} className="text-blue-600 text-xs font-medium">
                    {t("products_view")}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {lookupError && (
        <p className="text-sm text-red-600 mt-4">{lookupError}</p>
      )}

      {search.trim() !== "" && online.length > 0 && (
        <div className="mt-6">
          <h3 className="font-semibold text-sm">{t("lookup_onlineResults")}</h3>
          <p className="text-xs text-slate-500 mb-2">{t("lookup_onlineHint")}</p>

          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[980px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("orderLookup_orderId")}</th>
                  <th className="text-left px-3 py-2">{t("history_time")}</th>
                  <th className="text-left px-3 py-2">{t("admin_store")}</th>
                  <th className="text-left px-3 py-2">{t("pos_customer")}</th>
                  <th className="text-left px-3 py-2">{t("lookup_phone")}</th>
                  <th className="text-left px-3 py-2">{t("lookup_saleType")}</th>
                  <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
                  <th className="text-left px-3 py-2">{t("lookup_delivery")}</th>
                  <th className="text-left px-3 py-2">{t("pos_total")}</th>
                  <th className="text-left px-3 py-2">{t("lookup_paid")}</th>
                  <th className="text-left px-3 py-2">{t("lookup_balance")}</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {online.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs">{r.reference || r.id.slice(0, 8).toUpperCase()}</td>
                    <td className="px-3 py-2">{new Date(r.occurred_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-slate-500">{r.store_name || r.store_id || "-"}</td>
                    <td className="px-3 py-2">{r.customer_name || "-"}</td>
                    <td className="px-3 py-2 text-slate-500">{r.phone || "-"}</td>
                    <td className="px-3 py-2 text-xs">{saleTypeLabel(r.sale_type)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PAY_STATUS_CLASS[r.payment_status]}`}>
                        {r.payment_status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.fulfilment_status || "-"}</td>
                    <td className="px-3 py-2 font-medium">{fmt(r.total)}</td>
                    <td className="px-3 py-2">{fmt(r.paid)}</td>
                    <td className="px-3 py-2">{fmt(r.balance)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => openOnline(r)} className="text-blue-600 text-xs font-medium">
                        {t("lookup_detail")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Receipt data={receipt} />

      {selected && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto"
          onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-lg my-8"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-semibold text-lg font-mono">{selected.sale_ref || selected.id.slice(0, 8).toUpperCase()}</h3>
                <p className="text-sm text-slate-500">{new Date(selected.created_at).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={reprint} disabled={printing || itemsLoading}
                  className="text-blue-600 text-sm font-medium disabled:text-slate-300 print:hidden">
                  {printing ? "..." : t("history_reprint")}
                </button>
                <button onClick={() => setSelected(null)} className="text-slate-400 text-xl leading-none">✕</button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm mb-4">
              <div><div className="text-xs text-slate-400 uppercase">{t("admin_store")}</div><div>{selected.store_id}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("pos_customer")}</div><div>{selected.customer_name || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("pos_cashier")}</div><div className="text-xs">{selected.cashier_email || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("pos_salesRep")}</div><div>{selected.sale_rep_name || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("pos_paymentMethod")}</div><div>{selected.payment_method || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("saleOrder_channel")}</div><div>{selected.channel || selected.order_type}</div></div>
              {selected.delivery_address && (
                <div className="col-span-2 sm:col-span-3">
                  <div className="text-xs text-slate-400 uppercase">{t("saleOrder_deliveryAddress")}</div>
                  <div>{selected.delivery_address}</div>
                </div>
              )}
              {selected.note && (
                <div className="col-span-2 sm:col-span-3">
                  <div className="text-xs text-slate-400 uppercase">{t("pos_note")}</div>
                  <div>{selected.note}</div>
                </div>
              )}
            </div>

            <div className="border border-slate-200 rounded-lg overflow-x-auto mb-4">
              <table className="w-full text-sm min-w-[420px]">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                    <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                    <th className="text-left px-3 py-2">{t("products_price")}</th>
                    <th className="text-left px-3 py-2">{t("pos_total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsLoading && <tr><td colSpan={4} className="text-center text-slate-400 py-4">...</td></tr>}
                  {!itemsLoading && items.map((i) => {
                    const returnedQty = returnedItems
                      .filter((r) => r.product_id === (i as any).product_id)
                      .reduce((sum, r) => sum + Number(r.qty), 0);
                    return (
                    <tr key={i.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        {i.product_name}
                        {returnedQty > 0 && (
                          <span className="ml-1 text-[10px] text-red-600">
                            ({t("returns_returnedBadge")} {returnedQty})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{i.qty}</td>
                      <td className="px-3 py-2">{fmt(i.unit_price)}</td>
                      <td className="px-3 py-2 font-medium">{fmt(i.line_total)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-slate-500">
                <span>{t("pos_subtotal")}</span><span>{fmt(selected.subtotal)}</span>
              </div>
              {Number(selected.discount_amount) > 0 && (
                <div className="flex justify-between text-orange-600">
                  <span>
                    {t("pos_discount")}
                    {selected.discount_type === "percent" ? ` (${selected.discount_value}%)` : ""}
                    {selected.discount_approved_by && (
                      <span className="text-xs text-slate-400"> · {t("pos_discountApprovedBy")} {selected.discount_approved_by}</span>
                    )}
                  </span>
                  <span>-{fmt(selected.discount_amount)}</span>
                </div>
              )}
              {Number(selected.vat_amount) > 0 && (
                <div className="flex justify-between text-slate-500">
                  <span>VAT</span><span>{fmt(selected.vat_amount)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-base border-t border-slate-200 pt-2">
                <span>{t("pos_total")}</span><span>{fmt(selected.total)}</span>
              </div>
              {Number(selected.balance_due) > 0 && (
                <div className="flex justify-between text-orange-600 font-medium">
                  <span>{t("pos_balanceDue")}</span><span>{fmt(selected.balance_due)}</span>
                </div>
              )}
              {refundTotal > 0 && (
                <>
                  <div className="flex justify-between text-red-600 font-medium">
                    <span>{t("orderLookup_returned")}</span><span>-{fmt(refundTotal)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-base border-t border-slate-200 pt-2">
                    <span>{t("orderLookup_netTotal")}</span>
                    <span>{fmt(Number(selected.total) - refundTotal)}</span>
                  </div>
                </>
              )}
              {!itemsLoading && (
                <div className="flex justify-between text-green-700 font-medium border-t border-slate-100 pt-2 mt-2">
                  <span>{t("dashboard_gp")}</span><span>{fmt(gp)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {onlineSelected && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto"
          onClick={() => setOnlineSelected(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-lg my-8"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-semibold text-lg font-mono">
                  {onlineSelected.reference || onlineSelected.id.slice(0, 8).toUpperCase()}
                </h3>
                <p className="text-sm text-slate-500">{new Date(onlineSelected.occurred_at).toLocaleString()}</p>
              </div>
              {/* Read only — a CRM order must not be edited from the till */}
              <button onClick={() => setOnlineSelected(null)} className="text-slate-400 text-xl leading-none">✕</button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm mb-4">
              <div><div className="text-xs text-slate-400 uppercase">{t("admin_store")}</div><div>{onlineSelected.store_name || onlineSelected.store_id || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("pos_customer")}</div><div>{onlineSelected.customer_name || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("lookup_phone")}</div><div>{onlineSelected.phone || "-"}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("lookup_saleType")}</div><div>{saleTypeLabel(onlineSelected.sale_type)}</div></div>
              <div><div className="text-xs text-slate-400 uppercase">{t("pos_paymentMethod")}</div><div>{onlineSelected.payment_method || "-"}</div></div>
              <div>
                <div className="text-xs text-slate-400 uppercase">{t("saleOrder_status")}</div>
                <div>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PAY_STATUS_CLASS[onlineSelected.payment_status]}`}>
                    {onlineSelected.payment_status}
                  </span>
                </div>
              </div>
              <div><div className="text-xs text-slate-400 uppercase">{t("lookup_delivery")}</div><div>{onlineSelected.fulfilment_status || "-"}</div></div>
              {onlineSelected.voucher_no && (
                <div><div className="text-xs text-slate-400 uppercase">{t("lookup_voucher")}</div><div className="font-mono text-xs">{onlineSelected.voucher_no}</div></div>
              )}
              {onlineSelected.note && (
                <div className="col-span-2 sm:col-span-3">
                  <div className="text-xs text-slate-400 uppercase">{t("pos_note")}</div>
                  <div>{onlineSelected.note}</div>
                </div>
              )}
            </div>

            <div className="border border-slate-200 rounded-lg overflow-x-auto mb-4">
              <table className="w-full text-sm min-w-[420px]">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                    <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                    <th className="text-left px-3 py-2">{t("products_price")}</th>
                    <th className="text-left px-3 py-2">{t("pos_total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {onlineItemsLoading && <tr><td colSpan={4} className="text-center text-slate-400 py-4">...</td></tr>}
                  {!onlineItemsLoading && onlineItems.map((i, idx) => (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="px-3 py-2">{i.description}</td>
                      <td className="px-3 py-2">{i.qty}</td>
                      <td className="px-3 py-2">{fmt(i.unit_price)}</td>
                      <td className="px-3 py-2 font-medium">{fmt(i.line_total)}</td>
                    </tr>
                  ))}
                  {!onlineItemsLoading && onlineItems.length === 0 && (
                    <tr><td colSpan={4} className="text-center text-slate-400 py-4">-</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="space-y-1 text-sm">
              <div className="flex justify-between font-bold text-base border-t border-slate-200 pt-2">
                <span>{t("pos_total")}</span><span>{fmt(onlineSelected.total)}</span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>{t("lookup_paid")}</span><span>{fmt(onlineSelected.paid)}</span>
              </div>
              <div className="flex justify-between text-orange-600 font-medium">
                <span>{t("lookup_balance")}</span><span>{fmt(onlineSelected.balance)}</span>
              </div>
            </div>

            <div className="flex justify-end mt-4">
              <button onClick={() => setOnlineSelected(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium">
                {t("products_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
