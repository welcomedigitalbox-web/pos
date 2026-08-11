"use client";

import { useEffect, useState } from "react";
import { supabase, Product } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

type LedgerRow = {
  date: string;
  type: "in" | "out";
  qty: number;
  reference: string;
};

export default function LedgerPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [rows, setRows] = useState<(LedgerRow & { balance: number })[]>([]);

  useEffect(() => {
    if (profile && profile.role === "cashier") router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (productId) loadLedger(productId);
    else setRows([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  if (!profile || profile.role === "cashier") return null;

  async function loadProducts() {
    const { data } = await supabase.from("products").select("*").eq("store_id", storeId).order("name");
    setProducts(data || []);
  }

  async function loadLedger(pid: string) {
    const { data: purchases } = await supabase
      .from("stock_purchases")
      .select("qty, created_at, supplier")
      .eq("product_id", pid)
      .order("created_at", { ascending: true });

    const { data: items } = await supabase
      .from("sale_items")
      .select("qty, created_at, sale_id")
      .eq("product_id", pid)
      .order("created_at", { ascending: true });

    const combined: LedgerRow[] = [
      ...(purchases || []).map((p) => ({
        date: p.created_at,
        type: "in" as const,
        qty: Number(p.qty),
        reference: p.supplier ? `Stock-in (${p.supplier})` : "Stock-in",
      })),
      ...(items || []).map((i) => ({
        date: i.created_at,
        type: "out" as const,
        qty: Number(i.qty),
        reference: `Sale #${i.sale_id.slice(0, 8).toUpperCase()}`,
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    const withBalance = combined.map((r) => {
      balance += r.type === "in" ? r.qty : -r.qty;
      return { ...r, balance };
    });
    setRows(withBalance.reverse());
  }

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-3">{t("ledger_title")}</h2>

      <select
        className="w-full sm:w-80 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        value={productId}
        onChange={(e) => setProductId(e.target.value)}
      >
        <option value="">{t("ledger_selectProduct")}</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {productId && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[500px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("ledger_date")}</th>
                <th className="text-left px-3 py-2">{t("ledger_type")}</th>
                <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                <th className="text-left px-3 py-2">{t("ledger_balance")}</th>
                <th className="text-left px-3 py-2">{t("ledger_reference")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(r.date).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        r.type === "in" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {r.type === "in" ? t("ledger_in") : t("ledger_out")}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.type === "in" ? "+" : "-"}
                    {r.qty}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.balance}</td>
                  <td className="px-3 py-2 text-slate-400">{r.reference}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-8">
                    {t("ledger_empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
