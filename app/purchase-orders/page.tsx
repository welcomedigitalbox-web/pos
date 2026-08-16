"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, Supplier, PoStatus, PaymentTerm } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type PoRow = {
  id: string;
  po_number: string;
  status: PoStatus;
  payment_term: PaymentTerm;
  order_date: string;
  supplierName: string;
  total: number;
  paid: number;
};

const statusColor: Record<PoStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  ordered: "bg-blue-100 text-blue-700",
  partial: "bg-yellow-100 text-yellow-700",
  received: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
};

export default function PurchaseOrdersPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<PoRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [paymentTerm, setPaymentTerm] = useState<PaymentTerm>("credit");
  const [expectedDate, setExpectedDate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "purchase-orders")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "purchase-orders")) return null;

  async function load() {
    setLoading(true);
    const { data: sups } = await supabase.from("suppliers").select("*").eq("is_active", true).order("name");
    setSuppliers((sups as Supplier[]) || []);

    const { data: pos } = await supabase
      .from("purchase_orders")
      .select("*, suppliers(name), purchase_order_items(qty, unit_cost), po_payments(amount)")
      .order("created_at", { ascending: false });

    setRows(
      ((pos as any[]) || []).map((po) => ({
        id: po.id,
        po_number: po.po_number,
        status: po.status,
        payment_term: po.payment_term,
        order_date: po.order_date,
        supplierName: po.suppliers?.name || "-",
        total: (po.purchase_order_items || []).reduce(
          (s: number, i: any) => s + Number(i.qty) * Number(i.unit_cost), 0),
        paid: (po.po_payments || []).reduce((s: number, p: any) => s + Number(p.amount), 0),
      }))
    );
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function createPo(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const poNumber = `PO-${Date.now().toString().slice(-8)}`;
      const { data, error } = await supabase
        .from("purchase_orders")
        .insert({
          po_number: poNumber,
          supplier_id: supplierId || null,
          payment_term: paymentTerm,
          expected_date: expectedDate || null,
          note: note.trim() || null,
          created_by: profile?.email || null,
        })
        .select()
        .single();
      if (error) throw error;
      setShowForm(false);
      router.push(`/purchase-orders/${data.id}`);
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  const filtered = statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter);

  const q = search.trim().toLowerCase();
  const visibleRows = q
    ? rows.filter(
        (po) =>
          po.po_number.toLowerCase().includes(q) ||
          (po.supplierName || "").toLowerCase().includes(q)
      )
    : rows;

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-semibold text-lg">{t("nav_purchaseOrders")}</h2>
        <button onClick={() => setShowForm(true)} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("po_addNew")}
        </button>
      </div>

      <select
        className="border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
      >
        <option value="all">{t("warehouse_allStock")}</option>
        <option value="draft">{t("po_status_draft")}</option>
        <option value="ordered">{t("po_status_ordered")}</option>
        <option value="partial">{t("po_status_partial")}</option>
        <option value="received">{t("po_status_received")}</option>
        <option value="cancelled">{t("po_status_cancelled")}</option>
      </select>

      <input
        className="w-full sm:w-96 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        placeholder={t("po_searchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("po_number")}</th>
              <th className="text-left px-4 py-2">{t("nav_suppliers")}</th>
              <th className="text-left px-4 py-2">{t("po_orderDate")}</th>
              <th className="text-left px-4 py-2">{t("po_paymentTerm")}</th>
              <th className="text-left px-4 py-2">{t("pos_total")}</th>
              <th className="text-left px-4 py-2">{t("po_balance")}</th>
              <th className="text-left px-4 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && filtered.map((r) => {
              const balance = r.total - r.paid;
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium">{r.po_number}</td>
                  <td className="px-4 py-2">{r.supplierName}</td>
                  <td className="px-4 py-2 text-slate-400">{r.order_date}</td>
                  <td className="px-4 py-2 text-xs">{t(`po_term_${r.payment_term}` as any)}</td>
                  <td className="px-4 py-2">{fmt(r.total)}</td>
                  <td className={`px-4 py-2 font-medium ${balance > 0 ? "text-orange-600" : "text-green-700"}`}>
                    {fmt(balance)}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status]}`}>
                      {t(`po_status_${r.status}` as any)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/purchase-orders/${r.id}`} className="text-blue-600 text-xs font-medium">
                      {t("products_view")}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={createPo} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("po_addNew")}</h3>

            <label className="text-sm text-slate-600">{t("nav_suppliers")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">{t("stockIn_selectPlaceholder")}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>

            <label className="text-sm text-slate-600">{t("po_paymentTerm")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={paymentTerm} onChange={(e) => setPaymentTerm(e.target.value as PaymentTerm)}>
              <option value="advance">{t("po_term_advance")}</option>
              <option value="cod">{t("po_term_cod")}</option>
              <option value="credit">{t("po_term_credit")}</option>
              <option value="paid">{t("po_term_paid")}</option>
            </select>

            <label className="text-sm text-slate-600">{t("po_expectedDate")}</label>
            <input type="date" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4" rows={2}
              value={note} onChange={(e) => setNote(e.target.value)} />

            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("products_save")}
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
