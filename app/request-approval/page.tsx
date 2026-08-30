"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, logActivity } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type PendingRequest = {
  id: string;
  request_no: string | null;
  store_id: string;
  requested_warehouse_id: string | null;
  product_id: string;
  variant_id: string | null;
  requested_qty: number;
  note: string | null;
  requested_by: string | null;
  created_at: string;
  products: { name: string } | null;
  product_variants: { variant_name: string } | null;
};

// Mirrors canApproveRequest in stock-request/page.tsx and
// is_approver_role() in the database.


export default function RequestApprovalPage() {
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [storeFilter, setStoreFilter] = useState("all");
  const [toast, setToast] = useState("");

  const canApprove = !!profile && APPROVER_ROLES.includes(profile.role);

  useEffect(() => {
    if (profile && !canApprove) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (canApprove) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canApprove]);

  if (!profile || !canApprove) return null;

  // Deliberately not scoped to the selected store: this is an inbox across
  // every branch, so a sale manager approves without switching stores.
  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("stock_requests")
      .select("*, products(name), product_variants(variant_name)")
      .eq("status", "awaiting_approval")
      .order("created_at", { ascending: false })
      .limit(200);
    setRows((data as unknown as PendingRequest[]) || []);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  function displayName(r: PendingRequest) {
    const base = r.products?.name || "-";
    return r.product_variants?.variant_name
      ? `${base} (${r.product_variants.variant_name})`
      : base;
  }

  // Requests are raised one row per product but share a request_no, so
  // approving acts on the whole request the way the warehouse sees it.
  function groupKey(r: PendingRequest) {
    return r.request_no || r.id;
  }

  const grouped = useMemo(() => {
    const visible = storeFilter === "all" ? rows : rows.filter((r) => r.store_id === storeFilter);
    const map = new Map<string, PendingRequest[]>();
    for (const r of visible) {
      const k = groupKey(r);
      map.set(k, [...(map.get(k) || []), r]);
    }
    return Array.from(map.entries());
  }, [rows, storeFilter]);

  const stores = useMemo(
    () => Array.from(new Set(rows.map((r) => r.store_id))).sort(),
    [rows]
  );

  async function approve(key: string, lines: PendingRequest[]) {
    setBusyId(key);
    try {
      const ids = lines.map((l) => l.id);
      const { error } = await supabase
        .from("stock_requests")
        .update({
          status: "pending",
          approved_by: profile!.email,
          approved_at: new Date().toISOString(),
        })
        .in("id", ids);
      if (error) throw error;

      await logActivity({
        entityType: "stock_request",
        entityId: lines[0].id,
        action: "sale_approved",
        detail: `${lines[0].request_no || key} · ${lines[0].store_id} · ${lines.length} lines`,
      });

      showToast(t("stockRequest_approvedSent"));
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(key: string, lines: PendingRequest[]) {
    if (!rejectReason.trim()) return showToast(t("returns_reasonRequired") || "Reason required");
    setBusyId(key);
    try {
      const ids = lines.map((l) => l.id);
      const { error } = await supabase
        .from("stock_requests")
        .update({
          status: "rejected",
          approved_by: profile!.email,
          approved_at: new Date().toISOString(),
          rejected_reason: rejectReason.trim(),
        })
        .in("id", ids);
      if (error) throw error;

      await logActivity({
        entityType: "stock_request",
        entityId: lines[0].id,
        action: "sale_rejected",
        detail: `${lines[0].request_no || key} · ${rejectReason.trim()}`,
      });

      setRejectId(null);
      setRejectReason("");
      showToast(t("returns_status_rejected"));
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="pt-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-lg">{t("requestApproval_title") || "Request Approval"}</h2>
          <p className="text-sm text-slate-500">
            {t("requestApproval_subtitle") || "Store requests waiting for your approval"}
          </p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2">
          <div className="text-xs text-amber-700 uppercase">{t("returns_status_pending")}</div>
          <div className="text-xl font-semibold text-amber-800">{grouped.length}</div>
        </div>
      </div>

      {stores.length > 1 && (
        <select
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
          value={storeFilter}
          onChange={(e) => setStoreFilter(e.target.value)}
        >
          <option value="all">{t("requestApproval_allStores") || "All stores"}</option>
          {stores.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      )}

      {loading ? (
        <div className="text-sm text-slate-400 py-8 text-center">…</div>
      ) : grouped.length === 0 ? (
        <div className="text-sm text-slate-400 py-12 text-center border border-slate-200 rounded-xl">
          {t("requestApproval_empty") || "Nothing waiting for approval"}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(([key, lines]) => (
            <div key={key} className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-medium text-sm">{lines[0].request_no || key}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {lines[0].store_id}
                    {lines[0].requested_warehouse_id && ` → ${lines[0].requested_warehouse_id}`}
                    {" · "}
                    {lines[0].requested_by}
                    {" · "}
                    {new Date(lines[0].created_at).toLocaleString()}
                  </div>
                  {lines[0].note && (
                    <div className="text-xs text-slate-600 mt-1 italic">{lines[0].note}</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => approve(key, lines)}
                    disabled={busyId === key}
                    className="px-4 py-1.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
                  >
                    {busyId === key ? "…" : t("stockRequest_approve")}
                  </button>
                  <button
                    onClick={() => { setRejectId(key); setRejectReason(""); }}
                    disabled={busyId === key}
                    className="px-4 py-1.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium"
                  >
                    {t("returns_reject")}
                  </button>
                </div>
              </div>

              <table className="w-full text-sm">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-t border-slate-100">
                      <td className="py-1.5">{displayName(l)}</td>
                      <td className="py-1.5 text-right font-medium w-24">{l.requested_qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {rejectId === key && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <input
                    autoFocus
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2"
                    placeholder={t("returns_rejectReason") || "Reason"}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => reject(key, lines)}
                      disabled={busyId === key}
                      className="px-4 py-1.5 bg-red-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
                    >
                      {t("returns_reject")}
                    </button>
                    <button
                      onClick={() => setRejectId(null)}
                      className="px-4 py-1.5 border border-slate-200 rounded-lg text-sm"
                    >
                      {t("returns_cancel") || "Cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
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
