"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "../../language-context";

type Line = {
  id: string;
  product_id: string;
  variant_id: string | null;
  requested_qty: number;
  received_qty: number | null;
  status: string;
  note: string | null;
  display_name: string;
  sku: string | null;
};

type Header = {
  request_no: string | null;
  store_id: string;
  requested_warehouse_id: string | null;
  created_at: string;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  warehouse_approved_by: string | null;
  warehouse_approved_at: string | null;
  rejected_by: string | null;
  reject_reason: string | null;
  rejected_reason: string | null;
  received_by: string | null;
};

const statusColor: Record<string, string> = {
  awaiting_approval: "bg-yellow-100 text-yellow-700",
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-blue-100 text-blue-700",
  received: "bg-green-100 text-green-700",
  mismatch: "bg-red-100 text-red-700",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
};

export default function StockRequestDetailPage() {
  const { requestNo } = useParams<{ requestNo: string }>();
  const router = useRouter();
  const { t } = useLanguage();

  const [lines, setLines] = useState<Line[]>([]);
  const [header, setHeader] = useState<Header | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (requestNo) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestNo]);

  async function load() {
    setLoading(true);
    const ref = decodeURIComponent(requestNo);

    // Older requests predate request_no and are identified by their row id,
    // so the same page answers to both.
    const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
    const query = supabase
      .from("stock_requests")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .order("created_at", { ascending: true });

    const { data } = isUuid
      ? await query.eq("id", ref)
      : await query.eq("request_no", ref);

    const rows = ((data as any[]) || []).map((r) => ({
      ...r,
      display_name: r.product_variants?.variant_name
        ? `${r.products?.name} (${r.product_variants.variant_name})`
        : r.products?.name || "-",
      sku: r.product_variants?.sku || r.products?.sku || null,
    }));

    setLines(rows);
    setHeader(rows[0] ? (rows[0] as Header) : null);
    setLoading(false);
  }

  const totals = useMemo(() => {
    const requested = lines.reduce((n, l) => n + Number(l.requested_qty || 0), 0);
    const received = lines.reduce((n, l) => n + Number(l.received_qty || 0), 0);
    return { requested, received };
  }, [lines]);

  const status = useMemo(() => {
    const set = new Set(lines.map((l) => l.status));
    return set.size === 1 ? [...set][0] : "mixed";
  }, [lines]);

  if (loading) {
    return <div className="pt-8 text-center text-sm text-slate-400">…</div>;
  }

  if (!lines.length) {
    return (
      <div className="pt-8 text-center">
        <p className="text-sm text-slate-500 mb-4 font-mono">{decodeURIComponent(requestNo)}</p>
        <button onClick={() => router.back()} className="text-blue-600 text-sm font-medium">
          {t("products_cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="pt-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4 print:hidden">
        <button onClick={() => router.back()} className="text-blue-600 text-sm font-medium">
          ← {t("nav_stockRequest")}
        </button>
        <button
          onClick={() => window.print()}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold"
        >
          {t("stockTransfer_print")}
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6 print:border-0 print:p-0">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold font-mono">
              {header?.request_no || decodeURIComponent(requestNo)}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {header?.store_id}
              {header?.requested_warehouse_id && ` → ${header.requested_warehouse_id}`}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {header && new Date(header.created_at).toLocaleString()}
            </p>
          </div>
          <span
            className={`px-3 py-1 rounded text-sm font-medium ${
              status === "mixed" ? "bg-slate-100 text-slate-600" : statusColor[status]
            }`}
          >
            {status === "mixed"
              ? t("stockTransfer_statusMixed")
              : t(`returns_status_${status}` as any) || status}
          </span>
        </div>

        <table className="w-full text-sm mb-6">
          <thead className="border-y border-slate-200 text-slate-500">
            <tr>
              <th className="text-left py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-right py-2">{t("stockRequest_requestedQty")}</th>
              <th className="text-right py-2">{t("transferIn_actual")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-100">
                <td className="py-2">
                  {l.display_name}
                  {l.note && <div className="text-xs text-slate-400">{l.note}</div>}
                </td>
                <td className="py-2 text-slate-400 text-xs">{l.sku || "-"}</td>
                <td className="py-2 text-right">{l.requested_qty}</td>
                <td className="py-2 text-right">{l.received_qty ?? "-"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-slate-200 font-medium">
            <tr>
              <td className="py-2" colSpan={2}>
                {lines.length} {t("stockTransfer_lines")}
              </td>
              <td className="py-2 text-right">{totals.requested}</td>
              <td className="py-2 text-right">{totals.received || "-"}</td>
            </tr>
          </tfoot>
        </table>

        {/* The trail the request took, so anyone holding the sheet can see
            who cleared it without opening the audit log. */}
        <div className="grid grid-cols-3 gap-6 text-sm border-t border-slate-200 pt-4">
          <div>
            <div className="text-xs text-slate-400 uppercase mb-1">
              {t("returns_requestedBy")}
            </div>
            <div>{header?.requested_by || "-"}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 uppercase mb-1">
              {t("admin_dept_sale")}
            </div>
            <div>{header?.approved_by || "-"}</div>
            {header?.approved_at && (
              <div className="text-xs text-slate-400">
                {new Date(header.approved_at).toLocaleDateString()}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-slate-400 uppercase mb-1">
              {t("admin_dept_warehouse")}
            </div>
            <div>{header?.warehouse_approved_by || "-"}</div>
            {header?.warehouse_approved_at && (
              <div className="text-xs text-slate-400">
                {new Date(header.warehouse_approved_at).toLocaleDateString()}
              </div>
            )}
          </div>
        </div>

        {(header?.rejected_by || header?.reject_reason || header?.rejected_reason) && (
          <div className="text-sm text-red-600 mt-4 border-t border-slate-200 pt-4">
            {t("returns_status_rejected")}
            {header.rejected_by && `: ${header.rejected_by}`}
            {(header.reject_reason || header.rejected_reason) &&
              ` · ${header.reject_reason || header.rejected_reason}`}
          </div>
        )}

        <div className="hidden print:grid grid-cols-2 gap-12 mt-16 text-sm">
          <div className="border-t border-slate-400 pt-2">{t("stockTransfer_sentBy")}</div>
          <div className="border-t border-slate-400 pt-2">{t("po_receivedBy")}</div>
        </div>
      </div>
    </div>
  );
}
