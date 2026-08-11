"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export default function DashboardPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const router = useRouter();
  const [todayTotal, setTodayTotal] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [lowStock, setLowStock] = useState(0);

  useEffect(() => {
    if (profile && profile.role === "cashier") {
      router.replace("/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || profile.role === "cashier") return null;

  async function load() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: sales } = await supabase
      .from("sales")
      .select("total")
      .eq("store_id", storeId)
      .gte("created_at", todayStart.toISOString());

    setTodayTotal((sales || []).reduce((sum, s) => sum + Number(s.total), 0));
    setTodayCount((sales || []).length);

    const { data: low } = await supabase
      .from("products")
      .select("id")
      .eq("store_id", storeId)
      .lte("stock_qty", 5);
    setLowStock((low || []).length);
  }

  const cards = [
    { label: "ယနေ့ Sale", value: fmt(todayTotal) },
    { label: "ယနေ့ Order", value: String(todayCount) },
    { label: "Low Stock Items", value: String(lowStock) },
  ];

  return (
    <div className="pt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">{c.label}</div>
          <div className="text-xl font-bold mt-1">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
