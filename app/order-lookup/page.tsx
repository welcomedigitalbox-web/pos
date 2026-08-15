"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

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

  useEffect(() => {
    if (profile && !hasPermission(profile, "order-lookup")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "order-lookup")) return null;

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("sales")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    setOrders((data as Order[]) || []);

    const { data: returned } = await supabase
      .from("sale_returns")
      .select("original_sale_id")
      .eq("status", "approved");
    setReturnedSaleIds(
      new Set(((returned as any[]) || []).map((r) => r.original_sale_id).filter(Boolean))
    );

    setLoading(false);
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
    setItemsLoading(false);
  }

  // Matching on the short reference shown on receipts, plus customer and staff
  const q = search.trim().toLowerCase();
  const filtered = q
    ? orders.filter((o) => {
        const ref = o.id.slice(0, 8).toLowerCase();
        return (
          o.id.toLowerCase().includes(q) ||
          ref.includes(q) ||
          (o.customer_name || "").toLowerCase().includes(q) ||
          (o.cashier_email || "").toLowerCase().includes(q) ||
          (o.sale_rep_name || "").toLowerCase().includes(q)
        );
      })
    : orders;

  // This order's own discount is already known, so apply it directly
  const grossGp = items.reduce((s, i) => s + (Number(i.line_total) - Number(i.line_cogs || 0)), 0);
  const gp = grossGp - Number(selected?.discount_amount || 0);

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
                  {o.id.slice(0, 8).toUpperCase()}
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

      {selected && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto"
          onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-lg my-8"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="font-semibold text-lg font-mono">{selected.id.slice(0, 8).toUpperCase()}</h3>
                <p className="text-sm text-slate-500">{new Date(selected.created_at).toLocaleString()}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 text-xl leading-none">✕</button>
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
                  {!itemsLoading && items.map((i) => (
                    <tr key={i.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{i.product_name}</td>
                      <td className="px-3 py-2">{i.qty}</td>
                      <td className="px-3 py-2">{fmt(i.unit_price)}</td>
                      <td className="px-3 py-2 font-medium">{fmt(i.line_total)}</td>
                    </tr>
                  ))}
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
              {!itemsLoading && (
                <div className="flex justify-between text-green-700 font-medium border-t border-slate-100 pt-2 mt-2">
                  <span>{t("dashboard_gp")}</span><span>{fmt(gp)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
