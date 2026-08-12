"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function DashboardPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const [todayTotal, setTodayTotal] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [lowStock, setLowStock] = useState(0);
  const [todayCogs, setTodayCogs] = useState(0);

  useEffect(() => {
    if (profile && !hasPermission(profile, "dashboard")) {
      router.replace("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "dashboard")) return null;

  async function load() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: sales } = await supabase
      .from("sales")
      .select("id, total")
      .eq("store_id", storeId)
      .gte("created_at", todayStart.toISOString());

    const total = (sales || []).reduce((sum, s) => sum + Number(s.total), 0);
    setTodayTotal(total);
    setTodayCount((sales || []).length);

    const saleIds = (sales || []).map((s) => s.id);
    if (saleIds.length > 0) {
      const { data: items } = await supabase
        .from("sale_items")
        .select("line_cogs")
        .in("sale_id", saleIds);
      setTodayCogs((items || []).reduce((sum, i) => sum + Number(i.line_cogs), 0));
    } else {
      setTodayCogs(0);
    }

    const { data: low } = await supabase
      .from("products")
      .select("id")
      .eq("store_id", storeId)
      .lte("stock_qty", 5);
    setLowStock((low || []).length);
  }

  const gp = todayTotal - todayCogs;
  const gpMargin = todayTotal > 0 ? (gp / todayTotal) * 100 : 0;

  const cards = [
    { label: t("dashboard_todaySale"), value: fmt(todayTotal) },
    { label: t("dashboard_todayOrder"), value: String(todayCount) },
    { label: t("dashboard_todayCogs"), value: fmt(todayCogs) },
    { label: t("dashboard_gp"), value: fmt(gp) },
    { label: t("dashboard_gpMargin"), value: gpMargin.toFixed(1) + "%" },
    { label: t("dashboard_lowStock"), value: String(lowStock) },
  ];

  return (
    <div className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">{c.label}</div>
          <div className="text-xl font-bold mt-1">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
