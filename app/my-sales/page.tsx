"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type MySaleRow = {
  id: string;
  created_at: string;
  total: number;
  payment_method: string;
};

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function MySalesPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [sales, setSales] = useState<MySaleRow[]>([]);

  useEffect(() => {
    if (profile && !hasPermission(profile, "my-sales")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (profile) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, profile]);

  if (!profile || !hasPermission(profile, "my-sales")) return null;

  async function load() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from("sales")
      .select("id, created_at, total, payment_method")
      .eq("store_id", storeId)
      .eq("cashier_email", profile!.email)
      .gte("created_at", todayStart.toISOString())
      .order("created_at", { ascending: false });

    setSales(data || []);
  }

  const todayTotal = sales.reduce((sum, s) => sum + Number(s.total), 0);
  const todayCount = sales.length;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("mySales_title")}</h2>
      <p className="text-sm text-slate-500 mb-4">{profile.email}</p>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t("mySales_todayTotal")}</div>
          <div className="text-xl font-bold mt-1">{fmt(todayTotal)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t("mySales_todayCount")}</div>
          <div className="text-xl font-bold mt-1">{todayCount}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[400px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">{t("mySales_time")}</th>
              <th className="text-left px-4 py-2">{t("pos_paymentMethod")}</th>
              <th className="text-left px-4 py-2">{t("mySales_amount")}</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{new Date(s.created_at).toLocaleTimeString()}</td>
                <td className="px-4 py-2 text-slate-400">{s.payment_method}</td>
                <td className="px-4 py-2 font-medium">{fmt(s.total)}</td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
