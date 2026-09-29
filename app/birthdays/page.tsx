"use client";

// Whose birthday falls in a given month — the customer's own and, more useful
// for a baby shop, their children's, with the age each one turns.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type Row = {
  whose: "customer" | "child";
  customer_id: string;
  customer_name: string;
  phone: string | null;
  store_id: string | null;
  person_name: string;
  dob: string;
  month: number;
  day: number;
  turning: number | null;
};

const MONTHS = [
  "ဇန်နဝါရီ", "ဖေဖော်ဝါရီ", "မတ်", "ဧပြီ", "မေ", "ဇွန်",
  "ဇူလိုင်", "ဩဂုတ်", "စက်တင်ဘာ", "အောက်တိုဘာ", "နိုဝင်ဘာ", "ဒီဇင်ဘာ",
];

export default function BirthdaysPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [who, setWho] = useState<"all" | "child" | "customer">("all");

  useEffect(() => {
    if (profile && !hasPermission(profile, "birthdays")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("birthday_calendar")
      .select("*")
      .eq("month", month)
      .order("day");
    setRows((data as Row[]) || []);
    setLoading(false);
  }, [month]);

  useEffect(() => { load(); }, [load]);

  if (!profile || !hasPermission(profile, "birthdays")) return null;

  const shown = rows.filter((r) => who === "all" || r.whose === who);
  const today = new Date();
  const isThisMonth = month === today.getMonth() + 1;

  // Grouped by day, because the shop works down the month one day at a time.
  const byDay = new Map<number, Row[]>();
  for (const r of shown) {
    const arr = byDay.get(r.day) || [];
    arr.push(r);
    byDay.set(r.day, arr);
  }
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);

  return (
    <div className="pt-4 max-w-3xl">
      <h1 className="text-xl font-bold mb-3">🎂 မွေးနေ့ ပြက္ခဒိန်</h1>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {MONTHS.map((m, i) => (
          <button
            key={m}
            onClick={() => setMonth(i + 1)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
              month === i + 1
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-200"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5 mb-4">
        {([["all", "အားလုံး"], ["child", "ကလေးများ"], ["customer", "ဖောက်သည်"]] as const).map(
          ([k, label]) => (
            <button
              key={k}
              onClick={() => setWho(k)}
              className={`px-2.5 py-1 rounded-lg text-xs border ${
                who === k ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-white text-slate-600 border-slate-200"
              }`}
            >
              {label}
            </button>
          )
        )}
        <span className="text-xs text-slate-400 self-center ml-1">{shown.length} ဦး</span>
      </div>

      {loading && <div className="text-slate-400 text-sm">…</div>}

      {!loading && days.length === 0 && (
        <div className="text-center text-slate-400 py-10 text-sm">
          ဤလတွင် မွေးနေ့ မရှိပါ
        </div>
      )}

      <div className="space-y-3">
        {days.map((d) => (
          <div key={d} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div
              className={`px-4 py-2 text-sm font-semibold ${
                isThisMonth && d === today.getDate()
                  ? "bg-rose-50 text-rose-700"
                  : "bg-slate-50 text-slate-600"
              }`}
            >
              {MONTHS[month - 1]} {d}
              {isThisMonth && d === today.getDate() && " · ယနေ့"}
            </div>
            <div className="divide-y divide-slate-100">
              {(byDay.get(d) || []).map((r, i) => (
                <Link
                  key={i}
                  href={`/customers/${r.customer_id}`}
                  className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="text-sm">
                      {r.whose === "child" ? "👶 " : "👤 "}
                      {r.person_name}
                      {r.whose === "child" && r.turning !== null && (
                        <span className="text-slate-400 text-xs ml-2">{r.turning} နှစ်</span>
                      )}
                    </div>
                    {r.whose === "child" && (
                      <div className="text-xs text-slate-400 truncate">
                        မိဘ — {r.customer_name}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 whitespace-nowrap ml-3">
                    {r.phone || "-"}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
