"use client";

// The paper copy of a conversion: what was taken apart, what came of it,
// who did it and when. It is the sheet that goes in the folder next to
// the delivery notes, so it is plain and it fits on one page.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Conv = {
  id: string;
  ref: string;
  store_id: string;
  note: string | null;
  cost: number;
  created_by: string | null;
  created_at: string;
  status: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_note: string | null;
};

type Line = {
  side: string;
  product_name: string | null;
  qty: number;
  unit_cost: number;
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const when = (s: string | null) =>
  s
    ? new Date(s).toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Yangon",
      })
    : "-";

export default function ConversionPrintPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [doc, setDoc] = useState<Conv | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    const [{ data: d }, { data: l }] = await Promise.all([
      supabase.from("stock_conversions").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("stock_conversion_lines")
        .select("side,product_name,qty,unit_cost")
        .eq("conversion_id", id)
        .order("side", { ascending: false }),
    ]);
    setDoc((d as Conv) || null);
    setLines((l as Line[]) || []);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const out = lines.filter((l) => l.side === "out");
  const into = lines.filter((l) => l.side === "in");
  const total = (rows: Line[]) =>
    rows.reduce((n, r) => n + Number(r.qty) * Number(r.unit_cost), 0);

  if (!doc) {
    return <main className="p-6 text-sm text-slate-500">Loading...</main>;
  }

  return (
    <main className="po-print p-6 max-w-3xl mx-auto text-sm">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">Conversion</h1>
          <p className="text-slate-500">{doc.ref}</p>
        </div>
        <button
          onClick={() => window.print()}
          className="px-3 py-1 border border-slate-300 rounded text-xs print:hidden"
        >
          Print
        </button>
      </div>

      {doc.status === "cancelled" && (
        <p className="mb-4 text-red-700 border border-red-200 bg-red-50 rounded px-3 py-2">
          Cancelled by {doc.cancelled_by} on {when(doc.cancelled_at)}
          {doc.cancel_note ? ` - ${doc.cancel_note}` : ""}. The stock was put back.
        </p>
      )}

      <table className="mb-5">
        <tbody>
          <Info label="Location" value={doc.store_id} />
          <Info label="Date" value={when(doc.created_at)} />
          <Info label="Done by" value={doc.created_by || "-"} />
          <Info label="Remark" value={doc.note || "-"} />
        </tbody>
      </table>

      <Table title="Taken apart" rows={out} />
      <Table title="Came back" rows={into} />

      <p className="mt-4 text-slate-600">
        Cost moved across: <span className="font-medium">{money(Number(doc.cost))} MMK</span>
        {" "}({money(total(out))} out, {money(total(into))} in)
      </p>

      <div className="mt-10 grid grid-cols-2 gap-10 text-xs text-slate-500">
        <div className="border-t border-slate-300 pt-1">Done by</div>
        <div className="border-t border-slate-300 pt-1">Checked by</div>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="pr-6 py-0.5 text-slate-500">{label}</td>
      <td className="py-0.5">{value}</td>
    </tr>
  );
}

function Table({ title, rows }: { title: string; rows: Line[] }) {
  return (
    <section className="mb-4">
      <h2 className="font-medium mb-1">{title}</h2>
      <table className="min-w-full border border-slate-200">
        <thead className="bg-slate-50">
          <tr className="text-left text-[11px] text-slate-500">
            <th className="border border-slate-200 px-2 py-1">Product</th>
            <th className="border border-slate-200 px-2 py-1 w-20 text-right">Qty</th>
            <th className="border border-slate-200 px-2 py-1 w-28 text-right">Unit cost</th>
            <th className="border border-slate-200 px-2 py-1 w-28 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="border border-slate-200 px-2 py-1">{r.product_name}</td>
              <td className="border border-slate-200 px-2 py-1 text-right">{Number(r.qty)}</td>
              <td className="border border-slate-200 px-2 py-1 text-right">
                {money(Number(r.unit_cost))}
              </td>
              <td className="border border-slate-200 px-2 py-1 text-right">
                {money(Number(r.qty) * Number(r.unit_cost))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="px-2 py-1 text-slate-400">nothing</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
