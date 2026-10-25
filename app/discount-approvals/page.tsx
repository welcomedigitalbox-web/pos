"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";

type Row = {
  id: string;
  store_id: string;
  requester_email: string;
  subtotal: number;
  discount: number;
  customer_name: string | null;
  note: string | null;
  created_at: string;
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(n || 0));

const since = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  return `${Math.round(mins / 60)} hours ago`;
};

export default function DiscountApprovalsPage() {
  const { profile } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("my_discount_requests");
    if (error) { setErr(error.message); return; }
    setErr("");
    setRows((data as Row[]) || []);
  }, []);

  // A cashier is standing at a till with a customer in front of them, so
  // this list keeps itself current rather than waiting to be refreshed.
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function decide(id: string, approve: boolean) {
    const reason = approve ? null : prompt("Why not? (the till will see this)") || "";
    setBusy(id);
    const { error } = await supabase.rpc("decide_discount", {
      p_id: id, p_approve: approve, p_reason: reason,
    });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  if (!profile) return null;

  return (
    <div className="pt-4 max-w-2xl">
      <h2 className="font-semibold text-lg mb-1">Discount requests</h2>
      <p className="text-sm text-slate-500 mb-4">
        A till is waiting on each of these. They disappear after twelve hours.
      </p>

      {err && <p className="text-sm text-red-600 mb-3">{err}</p>}

      {rows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-400">
          Nothing waiting.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium">
                  {fmt(r.discount)} MMK off {fmt(r.subtotal)}
                </div>
                <div className="text-xs text-slate-400">{since(r.created_at)}</div>
              </div>
              <div className="text-sm text-slate-600 mt-1">
                {r.store_id} · {r.requester_email}
                {r.customer_name ? ` · ${r.customer_name}` : ""}
              </div>
              {r.note && (
                <div className="text-sm text-slate-500 mt-1">{r.note}</div>
              )}
              <div className="flex gap-2 mt-3">
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, true)}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  Allow it
                </button>
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, false)}
                  className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm disabled:opacity-50"
                >
                  No
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => router.push("/")}
        className="mt-6 text-sm text-slate-500 underline"
      >
        Back
      </button>
    </div>
  );
}
