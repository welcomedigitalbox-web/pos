"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase, Supplier } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

type SupplierRow = Supplier & {
  ordered: number; // total value of non-cancelled POs
  paid: number;
  balance: number; // still owed
};

export default function SuppliersPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [banks, setBanks] = useState<Map<string, { bank_name: string; account_no: string | null }>>(new Map());
  const [toast, setToast] = useState("");


  useEffect(() => {
    if (profile && !hasPermission(profile, "suppliers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "suppliers")) return null;

  async function load() {
    setLoading(true);
    const { data: sups } = await supabase.from("suppliers").select("*").order("name");

    // The account the shop pays into, shown beside the balance it owes.
    const { data: bankRows } = await supabase
      .from("supplier_bank_accounts")
      .select("supplier_id, bank_name, account_no, is_primary")
      .eq("is_primary", true);
    const bankBySupplier = new Map<string, { bank_name: string; account_no: string | null }>();
    for (const b of (bankRows as any[]) || []) bankBySupplier.set(b.supplier_id, b);
    setBanks(bankBySupplier);

    // Ordered value per supplier (exclude cancelled POs)
    const { data: pos } = await supabase
      .from("purchase_orders")
      .select("id, supplier_id, status, purchase_order_items(qty, unit_cost)")
      .neq("status", "cancelled");

    const { data: payments } = await supabase.from("po_payments").select("po_id, amount");

    const poTotal = new Map<string, number>();
    const poSupplier = new Map<string, string>();
    for (const po of (pos as any[]) || []) {
      const total = (po.purchase_order_items || []).reduce(
        (s: number, i: any) => s + Number(i.qty) * Number(i.unit_cost),
        0
      );
      poTotal.set(po.id, total);
      if (po.supplier_id) poSupplier.set(po.id, po.supplier_id);
    }

    const orderedBySupplier = new Map<string, number>();
    for (const [poId, total] of poTotal) {
      const sid = poSupplier.get(poId);
      if (!sid) continue;
      orderedBySupplier.set(sid, (orderedBySupplier.get(sid) || 0) + total);
    }

    const paidBySupplier = new Map<string, number>();
    for (const p of payments || []) {
      const sid = poSupplier.get(p.po_id);
      if (!sid) continue;
      paidBySupplier.set(sid, (paidBySupplier.get(sid) || 0) + Number(p.amount));
    }

    setRows(
      ((sups as Supplier[]) || []).map((s) => {
        const ordered = orderedBySupplier.get(s.id) || 0;
        const paid = paidBySupplier.get(s.id) || 0;
        return { ...s, ordered, paid, balance: ordered - paid };
      })
    );
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-semibold text-lg">{t("nav_suppliers")}</h2>
        <Link href="/suppliers/new" className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("suppliers_addNew")}
        </Link>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 inline-block">
        <div className="text-xs text-slate-500 uppercase">{t("suppliers_totalPayable")}</div>
        <div className={`text-xl font-bold mt-1 ${totalBalance > 0 ? "text-orange-600" : "text-green-700"}`}>
          {fmt(totalBalance)}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("customers_name")}</th>
              <th className="text-left px-4 py-2">{t("pos_customerPhone")}</th>
              <th className="text-left px-4 py-2">Bank</th>
              <th className="text-left px-4 py-2">{t("suppliers_ordered")}</th>
              <th className="text-left px-4 py-2">{t("suppliers_paid")}</th>
              <th className="text-left px-4 py-2">{t("suppliers_balance")}</th>
              <th className="text-left px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">...</td></tr>
            )}
            {!loading && rows.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium">{s.name}</td>
                <td className="px-4 py-2 text-slate-400">{s.phone || "-"}</td>
                <td className="px-4 py-2 text-slate-500 text-xs">
                  {banks.get(s.id)
                    ? `${banks.get(s.id)!.bank_name}${banks.get(s.id)!.account_no ? " · " + banks.get(s.id)!.account_no : ""}`
                    : <span className="text-slate-300">-</span>}
                </td>
                <td className="px-4 py-2">{fmt(s.ordered)}</td>
                <td className="px-4 py-2 text-green-700">{fmt(s.paid)}</td>
                <td className={`px-4 py-2 font-semibold ${s.balance > 0 ? "text-orange-600" : "text-slate-400"}`}>
                  {fmt(s.balance)}
                </td>
                <td className="px-4 py-2 text-right">
                  <Link href={`/suppliers/${s.id}/edit`} className="text-blue-600 text-xs font-medium">
                    {t("products_edit")}
                  </Link>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
