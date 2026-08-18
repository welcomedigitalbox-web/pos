"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, logActivity } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type Row = {
  id: string;
  owing_store_id: string;
  owed_store_id: string;
  amount: number;
  reason: string;
  note: string | null;
  status: "pending" | "settled";
  created_at: string;
  settled_by: string | null;
  settled_at: string | null;
  settle_method: string | null;
};

export default function SettlementsPage() {
  const { stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [toast, setToast] = useState("");

  const [settleRow, setSettleRow] = useState<Row | null>(null);
  const [method, setMethod] = useState("cash");
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "settlements")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "settlements")) return null;

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("inter_store_settlements")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    setRows((data as Row[]) || []);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function settle() {
    if (!settleRow) return;
    setSettling(true);
    try {
      const { error } = await supabase
        .from("inter_store_settlements")
        .update({
          status: "settled",
          settled_by: profile?.email || null,
          settled_at: new Date().toISOString(),
          settle_method: method,
        })
        .eq("id", settleRow.id);
      if (error) throw error;

      await logActivity({
        entityType: "settlement",
        entityId: settleRow.id,
        action: "settled",
        detail: `${settleRow.owing_store_id} → ${settleRow.owed_store_id} · ${fmt(Number(settleRow.amount))}`,
        actor: profile?.email,
      });

      showToast(t("settle_done"));
      setSettleRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSettling(false);
    }
  }

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name || id;

  const visible = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter)),
    [rows, statusFilter]
  );

  // Net position per store pair, so staff see one figure to settle rather than
  // a list of individual refunds
  const balances = useMemo(() => {
    const map = new Map<string, { owing: string; owed: string; amount: number; count: number }>();
    for (const r of rows.filter((x) => x.status === "pending")) {
      const key = `${r.owing_store_id}→${r.owed_store_id}`;
      const cur = map.get(key) || {
        owing: r.owing_store_id,
        owed: r.owed_store_id,
        amount: 0,
        count: 0,
      };
      cur.amount += Number(r.amount);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
  }, [rows]);

  const totalPending = balances.reduce((s, b) => s + b.amount, 0);

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_settlements")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("settle_subtitle")}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("settle_pendingCount")}</div>
          <div className="text-xl font-bold mt-1 text-orange-600">
            {rows.filter((r) => r.status === "pending").length}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("settle_pendingAmount")}</div>
          <div className="text-lg font-bold mt-1 text-orange-600">{fmt(totalPending)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("settle_pairs")}</div>
          <div className="text-xl font-bold mt-1">{balances.length}</div>
        </div>
      </div>

      {balances.length > 0 && (
        <>
          <h3 className="font-semibold mb-2">{t("settle_balanceTitle")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[520px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("settle_owing")}</th>
                  <th className="text-left px-3 py-2">{t("settle_owed")}</th>
                  <th className="text-left px-3 py-2">{t("settle_items")}</th>
                  <th className="text-left px-3 py-2">{t("settle_amount")}</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{storeName(b.owing)}</td>
                    <td className="px-3 py-2">{storeName(b.owed)}</td>
                    <td className="px-3 py-2 text-slate-500">{b.count}</td>
                    <td className="px-3 py-2 font-bold text-orange-600">{fmt(b.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="pending">{t("settle_status_pending")}</option>
          <option value="settled">{t("settle_status_settled")}</option>
          <option value="all">{t("warehouse_allStock")}</option>
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              <th className="text-left px-3 py-2">{t("returns_number")}</th>
              <th className="text-left px-3 py-2">{t("settle_owing")}</th>
              <th className="text-left px-3 py-2">{t("settle_owed")}</th>
              <th className="text-left px-3 py-2">{t("settle_amount")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && visible.map((r) => (
              <tr key={r.id} className={`border-t border-slate-100 ${r.status === "pending" ? "bg-orange-50/40" : ""}`}>
                <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.note || "-"}</td>
                <td className="px-3 py-2 font-medium">{storeName(r.owing_store_id)}</td>
                <td className="px-3 py-2">{storeName(r.owed_store_id)}</td>
                <td className="px-3 py-2 font-medium">{fmt(Number(r.amount))}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    r.status === "pending" ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"
                  }`}>
                    {t(`settle_status_${r.status}` as any)}
                  </span>
                  {r.settled_by && (
                    <div className="text-[10px] text-slate-400 mt-0.5">{r.settled_by}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {r.status === "pending" && (
                    <button onClick={() => { setSettleRow(r); setMethod("cash"); }}
                      className="text-green-600 text-xs font-medium">
                      {t("settle_markSettled")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {settleRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("settle_markSettled")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {storeName(settleRow.owing_store_id)} → {storeName(settleRow.owed_store_id)} ·{" "}
              <strong>{fmt(Number(settleRow.amount))}</strong>
            </p>

            <label className="text-sm text-slate-600">{t("returns_refundVia")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank Transfer</option>
              <option value="offset">{t("settle_offset")}</option>
            </select>

            <div className="flex gap-2">
              <button onClick={() => setSettleRow(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={settle} disabled={settling}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {settling ? "..." : t("settle_confirm")}
              </button>
            </div>
          </div>
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
