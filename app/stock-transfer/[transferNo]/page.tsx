"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../../auth-context";
import { useLanguage } from "../../language-context";

type Line = {
  id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  received_qty: number | null;
  status: string;
  unit_cost: number | null;
  discrepancy_note: string | null;
  display_name: string;
  sku: string | null;
};

type Header = {
  transfer_no: string;
  from_store_id: string;
  to_store_id: string;
  created_at: string;
  transferred_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  reject_reason: string | null;
  received_by: string | null;
};

const statusColor: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-700",
  in_transit: "bg-blue-100 text-blue-700",
  received: "bg-green-100 text-green-700",
  discrepancy: "bg-red-100 text-red-700",
  resolved: "bg-slate-100 text-slate-600",
  rejected: "bg-red-100 text-red-700",
};

export default function TransferDetailPage() {
  const { transferNo } = useParams<{ transferNo: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { t } = useLanguage();

  const [lines, setLines] = useState<Line[]>([]);
  const [header, setHeader] = useState<Header | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (transferNo) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferNo]);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("stock_transfers")
      .select("*, products(name, sku), product_variants(variant_name, sku)")
      .eq("transfer_no", decodeURIComponent(transferNo))
      .order("created_at", { ascending: true });

    const rows = ((data as any[]) || []).map((r) => ({
      ...r,
      display_name: r.product_variants?.variant_name
        ? `${r.products?.name} (${r.product_variants.variant_name})`
        : r.products?.name || "-",
      sku: r.product_variants?.sku || r.products?.sku || null,
    }));

    setLines(rows);
    // Every line of one dispatch shares its heading, so the first row
    // carries the whole header.
    setHeader(rows[0] ? (rows[0] as Header) : null);
    setLoading(false);
  }

  const totals = useMemo(() => {
    const sent = lines.reduce((n, l) => n + Number(l.qty || 0), 0);
    const received = lines.reduce((n, l) => n + Number(l.received_qty || 0), 0);
    const value = lines.reduce((n, l) => n + Number(l.qty || 0) * Number(l.unit_cost || 0), 0);
    return { sent, received, value };
  }, [lines]);

  // One status for the dispatch: they usually agree, and when they do not
  // the difference is worth showing rather than hiding behind an average.
  const status = useMemo(() => {
    const set = new Set(lines.map((l) => l.status));
    return set.size === 1 ? [...set][0] : "mixed";
  }, [lines]);

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

  if (loading) {
    return <div className="pt-8 text-center text-sm text-slate-400">…</div>;
  }

  if (!lines.length) {
    return (
      <div className="pt-8 text-center">
        <p className="text-sm text-slate-500 mb-4">{header?.transfer_no || decodeURIComponent(transferNo)}</p>
        <button onClick={() => router.back()} className="text-blue-600 text-sm font-medium">
          {t("products_cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="pt-4 max-w-4xl mx-auto">
      {/* Screen-only controls; the print sheet is the document itself. */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <button onClick={() => router.back()} className="text-blue-600 text-sm font-medium">
          ← {t("nav_stockTransfer")}
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
            <h1 className="text-2xl font-semibold font-mono">{header?.transfer_no}</h1>
            <p className="text-sm text-slate-500 mt-1">
              {header?.from_store_id} → {header?.to_store_id}
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
              : t(`transferIn_status_${status}` as any)}
          </span>
        </div>

        <table className="w-full text-sm mb-6">
          <thead className="border-y border-slate-200 text-slate-500">
            <tr>
              <th className="text-left py-2">{t("warehouse_colProduct")}</th>
              <th className="text-left py-2">{t("warehouse_colBarcode")}</th>
              <th className="text-right py-2">{t("transferIn_sent")}</th>
              <th className="text-right py-2">{t("transferIn_actual")}</th>
              <th className="text-right py-2">{t("transferIn_diff")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const diff = l.received_qty === null ? null : Number(l.received_qty) - Number(l.qty);
              return (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="py-2">{l.display_name}</td>
                  <td className="py-2 text-slate-400 text-xs">{l.sku || "-"}</td>
                  <td className="py-2 text-right">{l.qty}</td>
                  <td className="py-2 text-right">{l.received_qty ?? "-"}</td>
                  <td className={`py-2 text-right ${diff ? "text-red-600 font-medium" : "text-slate-400"}`}>
                    {diff === null ? "-" : diff === 0 ? "0" : diff > 0 ? `+${diff}` : diff}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-slate-200 font-medium">
            <tr>
              <td className="py-2" colSpan={2}>
                {lines.length} {t("stockTransfer_lines")}
              </td>
              <td className="py-2 text-right">{totals.sent}</td>
              <td className="py-2 text-right">{totals.received || "-"}</td>
              <td />
            </tr>
          </tfoot>
        </table>

        {/* Cost is the warehouse's business, not the receiving shop's. */}
        {profile?.role !== "cashier" && totals.value > 0 && (
          <div className="text-sm text-slate-500 mb-6">
            {t("warehouse_colAvgCost")}: {fmt(totals.value)}
          </div>
        )}

        <div className="grid grid-cols-2 gap-6 text-sm border-t border-slate-200 pt-4">
          <div>
            <div className="text-xs text-slate-400 uppercase mb-1">{t("stockTransfer_sentBy")}</div>
            <div>{header?.transferred_by || "-"}</div>
            {header?.approved_by && (
              <div className="text-xs text-slate-500 mt-2">
                {t("stockRequest_approved")}: {header.approved_by}
                {header.approved_at && ` · ${new Date(header.approved_at).toLocaleDateString()}`}
              </div>
            )}
            {header?.rejected_by && (
              <div className="text-xs text-red-600 mt-2">
                {t("returns_status_rejected")}: {header.rejected_by}
                {header.reject_reason && ` · ${header.reject_reason}`}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-slate-400 uppercase mb-1">{t("po_receivedBy")}</div>
            <div>{header?.received_by || "-"}</div>
          </div>
        </div>

        {/* Signature strip: a delivery note is only worth printing if
            someone can sign for what arrived. */}
        <div className="hidden print:grid grid-cols-2 gap-12 mt-16 text-sm">
          <div className="border-t border-slate-400 pt-2">{t("stockTransfer_sentBy")}</div>
          <div className="border-t border-slate-400 pt-2">{t("po_receivedBy")}</div>
        </div>
      </div>
    </div>
  );
}
