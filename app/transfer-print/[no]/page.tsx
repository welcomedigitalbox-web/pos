"use client";

// =====================================================================
// The paper that travels with the goods.
//
// A transfer exists in the system the moment it is sent, but the crate
// still has to be carried across town by somebody, handed over, and
// counted at the other end. That handover is where stock goes missing,
// and it is the one step with no screen in front of it — so it gets a
// piece of paper with three signatures on it: packed by, carried by,
// received by.
//
// The received column is deliberately blank. The person at the shop
// writes what they actually count, in pen, before anybody opens the app.
// A number already printed in that column is a number that gets copied
// rather than checked.
//
// A4, because that is what the office prints on, and black on white
// because warehouse printers are not colour.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Line = {
  id: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  unit_cost: number;
  status: string;
  received_qty: number | null;
};

type Head = {
  transfer_no: string;
  from_store_id: string;
  to_store_id: string;
  transferred_by: string | null;
  created_at: string;
  note: string | null;
  status: string;
};

const num = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

export default function TransferPrintPage() {
  const params = useParams<{ no: string }>();
  const no = decodeURIComponent(String(params?.no || ""));

  const [head, setHead] = useState<Head | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [names, setNames] = useState<Map<string, { name: string; sku: string | null }>>(new Map());
  const [stores, setStores] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!no) return;
    (async () => {
      const { data, error } = await supabase
        .from("stock_transfers")
        .select(
          "id, transfer_no, from_store_id, to_store_id, product_id, variant_id, qty, unit_cost, status, received_qty, transferred_by, created_at, note"
        )
        .eq("transfer_no", no)
        .order("created_at", { ascending: true });

      if (error) return setErr(error.message);
      if (!data || data.length === 0) return setErr(`No transfer ${no}`);

      const first = data[0] as any;
      setHead({
        transfer_no: first.transfer_no,
        from_store_id: first.from_store_id,
        to_store_id: first.to_store_id,
        transferred_by: first.transferred_by,
        created_at: first.created_at,
        note: first.note,
        status: first.status,
      });
      setLines(data as any);

      const ids = [...new Set(data.map((r: any) => r.product_id))];
      const [{ data: prods }, { data: sts }] = await Promise.all([
        supabase.from("products").select("id, name, sku").in("id", ids),
        supabase.from("stores").select("id, name"),
      ]);
      setNames(
        new Map((prods || []).map((p: any) => [p.id, { name: p.name, sku: p.sku }]))
      );
      setStores(new Map((sts || []).map((s: any) => [s.id, s.name])));
    })();
  }, [no]);

  const totalQty = useMemo(() => lines.reduce((s, l) => s + Number(l.qty || 0), 0), [lines]);

  if (err) {
    return <div className="p-6 text-sm text-red-700">{err}</div>;
  }
  if (!head) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }

  const storeName = (id: string) => stores.get(id) || id;

  return (
    <>
      {/* The sheet is defined in millimetres so what is on screen is what
          comes out of the printer, rather than whatever the browser
          decides a page is. */}
      <style>{`
        @page { size: A4; margin: 14mm 12mm; }

        /* The app is a fixed-height shell with its own scrolling box, and
           a printer asked to print that gets one blank viewport. So for
           printing the sheet is lifted out: everything else is hidden,
           the page is allowed to grow, and the sheet is pinned to the
           top-left of the paper. */
        @media print {
          html, body {
            height: auto !important;
            overflow: visible !important;
            background: #fff !important;
          }
          body * { visibility: hidden !important; }
          .sheet, .sheet * { visibility: visible !important; }
          .sheet {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: auto !important;
            margin: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
          }
          .no-print, .no-print * { display: none !important; visibility: hidden !important; }
          thead { display: table-header-group; }
          tr { break-inside: avoid; }
        }
        .sheet {
          width: 186mm;
          margin: 12px auto;
          padding: 10mm;
          background: #fff;
          color: #000;
          font-family: ui-sans-serif, system-ui, sans-serif;
        }
        .sheet table { width: 100%; border-collapse: collapse; }
        .sheet th, .sheet td {
          border: 0.4mm solid #000;
          padding: 2mm 2.5mm;
          font-size: 10.5pt;
          vertical-align: top;
        }
        .sheet th { background: #f2f2f2; text-align: left; font-weight: 600; }
        .num { text-align: right; font-variant-numeric: tabular-nums; }
      `}</style>

      <div className="no-print p-4 flex gap-2 items-center bg-gray-100 border-b">
        <button
          onClick={() => window.print()}
          className="rounded bg-blue-600 px-4 py-2 text-white text-sm font-medium"
        >
          Print
        </button>
        <span className="text-xs text-gray-500">
          Two copies: one travels with the goods, one stays at the warehouse.
        </span>
      </div>

      <div className="sheet">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: "16pt", fontWeight: 700 }}>Stock Transfer Note</div>
            <div style={{ fontSize: "10pt", marginTop: "1mm" }}>
              ပစ္စည်း လွှဲပြောင်းလွှာ
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "14pt", fontWeight: 700, fontFamily: "monospace" }}>
              {head.transfer_no}
            </div>
            <div style={{ fontSize: "9.5pt" }}>
              {new Date(head.created_at).toLocaleString()}
            </div>
          </div>
        </div>

        <table style={{ marginTop: "5mm" }}>
          <tbody>
            <tr>
              <th style={{ width: "22mm" }}>From</th>
              <td style={{ width: "62mm" }}>{storeName(head.from_store_id)}</td>
              <th style={{ width: "22mm" }}>To</th>
              <td>{storeName(head.to_store_id)}</td>
            </tr>
            <tr>
              <th>Packed by</th>
              <td>{head.transferred_by || "—"}</td>
              <th>Status</th>
              <td>{head.status}</td>
            </tr>
            {head.note && (
              <tr>
                <th>Note</th>
                <td colSpan={3}>{head.note}</td>
              </tr>
            )}
          </tbody>
        </table>

        <table style={{ marginTop: "5mm" }}>
          <thead>
            <tr>
              <th style={{ width: "10mm" }} className="num">#</th>
              <th>Item</th>
              <th style={{ width: "30mm" }}>Code</th>
              <th style={{ width: "20mm" }} className="num">Sent</th>
              <th style={{ width: "26mm" }} className="num">Received</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const p = names.get(l.product_id);
              return (
                <tr key={l.id}>
                  <td className="num">{i + 1}</td>
                  <td>{p?.name || l.product_id}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "9.5pt" }}>
                    {p?.sku || ""}
                  </td>
                  <td className="num">{num(l.qty)}</td>
                  {/* Left empty on purpose — counted in pen at the far end. */}
                  <td className="num" />
                </tr>
              );
            })}
            {/* A few blank lines, because something always gets added to
                the crate after the paper is printed. */}
            {Array.from({ length: Math.max(0, 3) }).map((_, i) => (
              <tr key={`blank-${i}`}>
                <td className="num">{lines.length + i + 1}</td>
                <td>&nbsp;</td>
                <td />
                <td />
                <td />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3} style={{ textAlign: "right" }}>Total</th>
              <th className="num">{num(totalQty)}</th>
              <th className="num" />
            </tr>
          </tfoot>
        </table>

        <table style={{ marginTop: "8mm" }}>
          <thead>
            <tr>
              <th style={{ width: "33%" }}>Packed by · ထုတ်သူ</th>
              <th style={{ width: "33%" }}>Carried by · သယ်သူ</th>
              <th>Received by · လက်ခံသူ</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ height: "22mm" }} />
              <td />
              <td />
            </tr>
            <tr>
              <td style={{ fontSize: "9pt" }}>Name / Date</td>
              <td style={{ fontSize: "9pt" }}>Name / Date</td>
              <td style={{ fontSize: "9pt" }}>Name / Date</td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: "4mm", fontSize: "9pt" }}>
          Count every line before signing. A signature here is the shop
          accepting the quantities written in the Received column —
          အရေအတွက် ရေမတွက်ဘဲ လက်မှတ် မထိုးပါနှင့်။
        </div>
      </div>
    </>
  );
}
