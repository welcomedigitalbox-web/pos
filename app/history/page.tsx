"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useLanguage } from "../language-context";

type SaleRow = {
  id: string;
  created_at: string;
  store_id: string;
  total: number;
  sale_items: { product_name: string; qty: number }[];
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function HistoryPage() {
  const { storeId } = useStore();
  const { t } = useLanguage();
  const [sales, setSales] = useState<SaleRow[]>([]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function load() {
    const { data, error } = await supabase
      .from("sales")
      .select("*, sale_items(product_name, qty)")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error) setSales((data as SaleRow[]) || []);
  }

  return (
    <div className="pt-4">
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("history_time")}</th>
              <th className="text-left px-4 py-2">{t("history_store")}</th>
              <th className="text-left px-4 py-2">{t("history_items")}</th>
              <th className="text-left px-4 py-2">{t("history_total")}</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{new Date(s.created_at).toLocaleString()}</td>
                <td className="px-4 py-2">{s.store_id}</td>
                <td className="px-4 py-2">
                  {s.sale_items?.map((i) => `${i.product_name} x${i.qty}`).join(", ")}
                </td>
                <td className="px-4 py-2 font-medium">{fmt(s.total)}</td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-slate-400 py-8">
                  {t("history_empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
