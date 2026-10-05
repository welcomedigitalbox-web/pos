"use client";

// =====================================================================
// Transfer report.
//
// The transfer screen answers "what is happening now". This answers the
// question somebody asks at the end of a month: how much went out, how
// much arrived, and where the difference went.
//
// The difference is the whole point. A transfer that arrives short is
// not an accident to be smoothed over — it is either a miscount at one
// end, breakage on the road, or theft, and which of the three it is
// only becomes visible when the shortfalls are lined up by route. One
// short delivery is noise. The same route short every week is a person.
//
// So the table sorts by what is missing, not by date, and the summary
// at the top is in money as well as pieces, because that is the number
// that gets attention.
// =====================================================================

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, describeError } from "@/lib/supabase";
import Link from "next/link";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Row = {
  id: string;
  transfer_no: string | null;
  from_store_id: string;
  to_store_id: string;
  product_id: string;
  qty: number;
  received_qty: number | null;
  status: string;
  transferred_by: string | null;
  received_by: string | null;
  resolution: string | null;
  resolution_note: string | null;
  created_at: string;
  received_at: string | null;
};

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const day = (s: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "In transit", tone: "text-amber-700" },
  pending_approval: { label: "Awaiting manager", tone: "text-amber-700" },
  received: { label: "Received", tone: "text-gray-600" },
  completed: { label: "Received", tone: "text-gray-600" },
  discrepancy: { label: "Short", tone: "text-red-700 font-medium" },
  resolved: { label: "Resolved", tone: "text-gray-500" },
  cancelled: { label: "Cancelled", tone: "text-gray-400" },
};

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function TransferReportPage() {
  const { profile } = useAuth();
  const router = useRouter();

  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [fromStore, setFromStore] = useState("");
  const [toStore, setToStore] = useState("");
  const [onlyShort, setOnlyShort] = useState(false);

  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [costs, setCosts] = useState<Map<string, number>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [canCancel, setCanCancel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (profile && !hasPermission(profile, "warehouse")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    supabase
      .from("stores")
      .select("id, name")
      .order("id")
      .then(({ data }) => setStores(data || []));
    supabase
      .rpc("can_approve_dept", { p_department: "warehouse" })
      .then(({ data }) => setCanCancel(!!data));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setCapped(false);

    let q = supabase
      .from("stock_transfers")
      .select(
        "id, transfer_no, from_store_id, to_store_id, product_id, qty, received_qty, status, transferred_by, received_by, resolution, resolution_note, created_at, received_at"
      )
      .gte("created_at", `${from}T00:00:00`)
      .lte("created_at", `${to}T23:59:59`)
      .order("created_at", { ascending: false })
      .limit(1000);

    if (fromStore) q = q.eq("from_store_id", fromStore);
    if (toStore) q = q.eq("to_store_id", toStore);

    const { data, error } = await q;
    if (error) {
      setErr(describeError(error));
      setLoading(false);
      return;
    }

    const list = (data || []) as Row[];
    // Supabase stops at a thousand rows whatever the limit says, so a
    // full thousand means the answer is incomplete, not that it is big.
    setCapped(list.length >= 1000);
    setRows(list);

    // Costs, so the shortfall can be stated in money. One query for the
    // products actually in the report, not the whole catalogue.
    const ids = [...new Set(list.map((r) => r.product_id))];
    if (ids.length) {
      const [{ data: prods }, { data: inv }] = await Promise.all([
        supabase.from("products").select("id, name").in("id", ids.slice(0, 300)),
        supabase
          .from("store_inventory")
          .select("product_id, avg_cost")
          .in("product_id", ids.slice(0, 300))
          .gt("avg_cost", 0)
          .limit(1000),
      ]);
      setNames(new Map((prods || []).map((p: any) => [p.id, p.name])));
      const c = new Map<string, number>();
      for (const r of inv || []) {
        if (!c.has(r.product_id)) c.set(r.product_id, Number(r.avg_cost) || 0);
      }
      setCosts(c);
    }

    setLoading(false);
  }, [from, to, fromStore, toStore]);

  useEffect(() => {
    load();
  }, [load]);

  const shortOf = (r: Row) =>
    r.received_qty === null ? 0 : Math.max(0, Number(r.qty) - Number(r.received_qty));

  const shown = useMemo(
    () => (onlyShort ? rows.filter((r) => shortOf(r) > 0) : rows),
    [rows, onlyShort]
  );

  // A transfer is a crate, not a line. One dispatch carries several
  // products, and the paperwork, the signature and the shortfall all
  // belong to the crate — so the table is one row per transfer, opened
  // up when somebody wants to see what was in it.
  type Group = {
    no: string;
    route: string;
    from: string;
    to: string;
    at: string;
    status: string;
    by: string | null;
    got_by: string | null;
    sent: number;
    got: number;
    short: number;
    value: number;
    lines: Row[];
  };

  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const r of shown) {
      const no = r.transfer_no || r.id;
      let g = m.get(no);
      if (!g) {
        g = {
          no,
          route: `${r.from_store_id} → ${r.to_store_id}`,
          from: r.from_store_id,
          to: r.to_store_id,
          at: r.created_at,
          status: r.status,
          by: r.transferred_by,
          got_by: r.received_by,
          sent: 0,
          got: 0,
          short: 0,
          value: 0,
          lines: [],
        };
        m.set(no, g);
      }
      g.lines.push(r);
      g.sent += Number(r.qty) || 0;
      g.got += Number(r.received_qty) || 0;
      const sh = shortOf(r);
      g.short += sh;
      g.value += sh * (costs.get(r.product_id) || 0);
      // The worst thing that happened to any line is the state of the crate.
      const rank = (st: string) =>
        st === "discrepancy" ? 4 : st === "pending_approval" ? 3 : st === "in_transit" ? 2 : 1;
      if (rank(r.status) > rank(g.status)) g.status = r.status;
    }
    return [...m.values()].sort(
      (a, b) => b.short - a.short || +new Date(b.at) - +new Date(a.at)
    );
  }, [shown, costs]);

  function toggle(no: string) {
    setOpen((p) => {
      const n = new Set(p);
      n.has(no) ? n.delete(no) : n.add(no);
      return n;
    });
  }

  // Nothing is edited after it is sent. The stock has already left the
  // shelf, so changing the number on the paper would put the books and
  // the building out of step — the honest undo is a cancellation, which
  // puts the goods back and leaves the cancelled transfer on the record.
  async function cancel(no: string) {
    const why = window.prompt(`Cancel ${no}? The stock goes back to the sender.\n\nReason:`);
    if (!why) return;
    setBusy(no);
    const { error } = await supabase.rpc("approve_transfer", {
      p_transfer_no: no,
      p_reject: true,
      p_reason: why,
    });
    setBusy(null);
    if (error) return setErr(describeError(error));
    load();
  }

  const totals = useMemo(() => {
    let sent = 0,
      got = 0,
      short = 0,
      value = 0,
      open = 0;
    for (const r of rows) {
      sent += Number(r.qty) || 0;
      got += Number(r.received_qty) || 0;
      const s = shortOf(r);
      short += s;
      value += s * (costs.get(r.product_id) || 0);
      if (r.status === "pending" || r.status === "pending_approval" || r.status === "discrepancy")
        open += 1;
    }
    return { sent, got, short, value, open };
  }, [rows, costs]);

  // Where the losses actually sit, which is the question worth asking.
  const byRoute = useMemo(() => {
    const m = new Map<string, { route: string; sent: number; short: number; value: number }>();
    for (const r of rows) {
      const key = `${r.from_store_id} → ${r.to_store_id}`;
      let g = m.get(key);
      if (!g) {
        g = { route: key, sent: 0, short: 0, value: 0 };
        m.set(key, g);
      }
      g.sent += Number(r.qty) || 0;
      const s = shortOf(r);
      g.short += s;
      g.value += s * (costs.get(r.product_id) || 0);
    }
    return [...m.values()].sort((a, b) => b.short - a.short);
  }, [rows, costs]);

  function csv() {
    const head = [
      "Transfer no", "Date", "From", "To", "Product", "Sent", "Received",
      "Short", "Cost of short", "Status", "Sent by", "Received by", "Resolution", "Note",
    ];
    const lines = shown.map((r) => {
      const s = shortOf(r);
      return [
        r.transfer_no || r.id.slice(0, 8),
        new Date(r.created_at).toISOString().slice(0, 10),
        r.from_store_id,
        r.to_store_id,
        (names.get(r.product_id) || r.product_id).replace(/"/g, '""'),
        r.qty,
        r.received_qty ?? "",
        s || "",
        s ? Math.round(s * (costs.get(r.product_id) || 0)) : "",
        STATUS[r.status]?.label || r.status,
        r.transferred_by || "",
        r.received_by || "",
        r.resolution || "",
        (r.resolution_note || "").replace(/"/g, '""'),
      ]
        .map((v) => `"${v}"`)
        .join(",");
    });
    const blob = new Blob([[head.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `transfers-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <h1 className="text-xl font-semibold">Transfer report</h1>
      <p className="mt-1 text-sm text-gray-500">
        What went out, what arrived, and what did not.
      </p>

      {/* filters */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="border rounded px-2 py-1.5" />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 className="border rounded px-2 py-1.5" />
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">Sent from</span>
          <select value={fromStore} onChange={(e) => setFromStore(e.target.value)}
                  className="border rounded px-2 py-1.5 min-w-[9rem]">
            <option value="">Anywhere</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-gray-600 mb-1">Sent to</span>
          <select value={toStore} onChange={(e) => setToStore(e.target.value)}
                  className="border rounded px-2 py-1.5 min-w-[9rem]">
            <option value="">Anywhere</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm flex items-center gap-2 pb-2">
          <input type="checkbox" checked={onlyShort}
                 onChange={(e) => setOnlyShort(e.target.checked)} />
          Short deliveries only
        </label>
        <button onClick={csv} disabled={!shown.length}
                className="ml-auto rounded border px-3 py-1.5 text-sm disabled:opacity-40">
          Export CSV
        </button>
      </div>

      {err && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}
      {capped && (
        <div className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          A thousand rows is as many as the database will return at once, so
          this period is cut off. Narrow the dates to see all of it.
        </div>
      )}

      {/* summary */}
      <div className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { k: "Sent", v: money(totals.sent) },
          { k: "Received", v: money(totals.got) },
          { k: "Short", v: money(totals.short), red: totals.short > 0 },
          { k: "Cost of short", v: money(totals.value), red: totals.value > 0 },
          { k: "Still open", v: money(totals.open) },
        ].map((c) => (
          <div key={c.k} className="border rounded p-3">
            <div className="text-xs text-gray-500">{c.k}</div>
            <div className={`text-xl font-semibold ${c.red ? "text-red-700" : ""}`}>{c.v}</div>
          </div>
        ))}
      </div>

      {/* by route */}
      {byRoute.some((r) => r.short > 0) && (
        <>
          <h2 className="mt-8 text-base font-semibold">Where the shortfalls are</h2>
          <p className="mt-1 text-xs text-gray-500">
            One short delivery is noise. The same route short every week is a person.
          </p>
          <div className="mt-3 overflow-x-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2">Route</th>
                  <th className="px-3 py-2 text-right">Sent</th>
                  <th className="px-3 py-2 text-right">Short</th>
                  <th className="px-3 py-2 text-right">%</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {byRoute.filter((r) => r.short > 0).map((r) => (
                  <tr key={r.route} className="border-t">
                    <td className="px-3 py-2 font-medium">{r.route}</td>
                    <td className="px-3 py-2 text-right">{money(r.sent)}</td>
                    <td className="px-3 py-2 text-right text-red-700">{money(r.short)}</td>
                    <td className="px-3 py-2 text-right">
                      {r.sent ? ((r.short / r.sent) * 100).toFixed(1) : "0.0"}%
                    </td>
                    <td className="px-3 py-2 text-right">{money(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* lines */}
      <h2 className="mt-8 text-base font-semibold">
        Transfers{" "}
        {loading && <span className="text-xs font-normal text-gray-400">loading…</span>}
      </h2>

      {groups.length === 0 && !loading ? (
        <p className="mt-3 text-sm text-gray-500">Nothing in this period.</p>
      ) : (
        <div className="mt-3 overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2 w-8" />
                <th className="px-3 py-2">No.</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Sent</th>
                <th className="px-3 py-2 text-right">Got</th>
                <th className="px-3 py-2 text-right">Short</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sent by</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const st = STATUS[g.status] || { label: g.status, tone: "text-gray-600" };
                const isOpen = open.has(g.no);
                return (
                  <Fragment key={g.no}>
                    <tr
                      className={`border-t cursor-pointer hover:bg-gray-50 ${
                        g.short > 0 ? "bg-red-50/40" : ""
                      }`}
                      onClick={() => toggle(g.no)}
                    >
                      <td className="px-3 py-2 text-gray-400">{isOpen ? "▾" : "▸"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{g.no}</td>
                      <td className="px-3 py-2 text-gray-600">{day(g.at)}</td>
                      <td className="px-3 py-2 text-gray-600">{g.route}</td>
                      <td className="px-3 py-2 text-right">{g.lines.length}</td>
                      <td className="px-3 py-2 text-right">{money(g.sent)}</td>
                      <td className="px-3 py-2 text-right">
                        {g.got ? money(g.got) : "—"}
                      </td>
                      <td className={`px-3 py-2 text-right ${g.short > 0 ? "text-red-700 font-medium" : "text-gray-300"}`}>
                        {g.short > 0 ? money(g.short) : "—"}
                      </td>
                      <td className={`px-3 py-2 ${st.tone}`}>{st.label}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{g.by || "—"}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Link
                          href={`/transfer-print/${encodeURIComponent(g.no)}`}
                          target="_blank"
                          onClick={(e) => e.stopPropagation()}
                          className="text-blue-600 hover:underline text-xs"
                        >
                          Print
                        </Link>
                        {canCancel && g.status === "pending_approval" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); cancel(g.no); }}
                            disabled={busy === g.no}
                            className="ml-3 text-red-700 hover:underline text-xs disabled:opacity-40"
                          >
                            {busy === g.no ? "…" : "Cancel"}
                          </button>
                        )}
                      </td>
                    </tr>

                    {isOpen &&
                      g.lines.map((r) => {
                        const sh = shortOf(r);
                        return (
                          <tr key={r.id} className="border-t bg-gray-50/60 text-xs">
                            <td />
                            <td className="px-3 py-1.5" colSpan={3}>
                              {names.get(r.product_id) || r.product_id}
                            </td>
                            <td />
                            <td className="px-3 py-1.5 text-right">{money(r.qty)}</td>
                            <td className="px-3 py-1.5 text-right">
                              {r.received_qty === null ? "—" : money(r.received_qty)}
                            </td>
                            <td className={`px-3 py-1.5 text-right ${sh > 0 ? "text-red-700" : "text-gray-300"}`}>
                              {sh > 0 ? money(sh) : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-gray-500" colSpan={3}>
                              {r.resolution
                                ? `${r.resolution}${r.resolution_note ? ` · ${r.resolution_note}` : ""}`
                                : r.received_by
                                ? `received by ${r.received_by}`
                                : ""}
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
