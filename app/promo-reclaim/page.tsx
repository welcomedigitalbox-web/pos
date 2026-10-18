"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";

// Free goods left over from a finished promotion. Until somebody collects
// them they sit on a shelf nobody is allowed to sell from, and the loss only
// shows up at the next stock count.
type Row = {
  promo_id: string;
  promo_name: string;
  ends_on: string | null;
  product_id: string;
  product_name: string;
  sku: string | null;
  store_id: string;
  store_name: string;
  qty: number;
  value: number;
};

function n0(n: unknown) {
  return Math.round(Number(n) || 0).toLocaleString();
}

function errText(err: unknown) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: string; details?: string; hint?: string };
    return e.message || e.details || e.hint || JSON.stringify(err);
  }
  return String(err);
}

export default function PromoReclaimPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "promotions")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
  }, []);

  const pageBlocked = !profile || !hasPermission(profile, "promotions");

  async function load() {
    setLoading(true);
    setErr("");
    const { data, error } = await supabase.rpc("promo_foc_reclaim_json");
    if (error) setErr(errText(error));
    setRows((data as Row[]) || []);
    setLoading(false);
  }

  function show(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function markCollected(promoId: string, promoName: string) {
    if (!confirm(`${promoName}\n\n${t("promoReclaim_confirm")}`)) return;
    setBusy(promoId);
    try {
      const { error } = await supabase.rpc("mark_promo_foc_reclaimed", { p_promo: promoId });
      if (error) throw error;
      show("✅ " + t("promoReclaim_done"));
      await load();
    } catch (e) {
      show("❌ " + errText(e));
    } finally {
      setBusy("");
    }
  }

  // One block per promotion, because collecting is organised by promotion -
  // one call to the shops, one transfer back.
  const promos = Array.from(new Set(rows.map((r) => r.promo_id))).map((pid) => {
    const mine = rows.filter((r) => r.promo_id === pid);
    return {
      id: pid,
      name: mine[0].promo_name,
      endsOn: mine[0].ends_on,
      lines: mine,
      qty: mine.reduce((s, r) => s + Number(r.qty || 0), 0),
      value: mine.reduce((s, r) => s + Number(r.value || 0), 0),
    };
  });

  if (pageBlocked) return null;

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg">{t("promoReclaim_title")}</h2>
      <p className="text-sm text-slate-500 mb-4">{t("promoReclaim_subtitle")}</p>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-3 py-2 mb-4 text-xs">
          {err}
        </div>
      )}

      {loading && <div className="text-center text-slate-400 py-10 text-sm">...</div>}

      {!loading && promos.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-10 text-center text-slate-400 text-sm">
          {t("promoReclaim_empty")}
        </div>
      )}

      <div className="space-y-4">
        {promos.map((p) => (
          <div key={p.id} className="bg-white border border-amber-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-amber-50 flex flex-wrap items-center gap-2">
              <div className="min-w-0">
                <div className="font-semibold truncate">{p.name}</div>
                <div className="text-xs text-slate-500">
                  {t("promoReclaim_endedOn")} {p.endsOn || "-"} &middot;{" "}
                  {n0(p.qty)} {t("promoReclaim_pcs")} &middot; {n0(p.value)} MMK
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Link
                  href="/stock-transfer"
                  className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-medium bg-white"
                >
                  {t("promoReclaim_transfer")}
                </Link>
                <button
                  onClick={() => markCollected(p.id, p.name)}
                  disabled={busy === p.id}
                  className="bg-green-600 disabled:bg-slate-300 text-white rounded-lg px-3 py-1.5 text-xs font-semibold"
                >
                  {busy === p.id ? "..." : t("promoReclaim_markCollected")}
                </button>
              </div>
            </div>

            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">{t("stockIn_product")}</th>
                  <th className="text-left px-4 py-2">{t("admin_stores_title")}</th>
                  <th className="text-right px-4 py-2">{t("po_orderQty")}</th>
                  <th className="text-right px-4 py-2">{t("warehouse_stockValue")}</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((r) => (
                  <tr key={`${r.product_id}:${r.store_id}`} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      {r.product_name}
                      {r.sku && <span className="text-xs text-slate-400"> · {r.sku}</span>}
                    </td>
                    <td className="px-4 py-2">{r.store_name}</td>
                    <td className="px-4 py-2 text-right font-semibold">{n0(r.qty)}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{n0(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
