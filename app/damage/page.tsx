"use client";

// =====================================================================
// Damage.
//
// Three people touch a damaged piece of stock and they do different
// things, so this page shows whichever of the three jobs the person
// signed in actually holds:
//
//   File      the senior accountant, working from a pile of damaged
//             goods. Scans each piece, types the quantity, sends the
//             pile to the warehouse. No stock moves — the goods are
//             still sitting in the shop.
//   Receive   the warehouse, when the pile arrives. One button. This is
//             where the shop's stock comes off, because this is the
//             moment somebody has the goods in their hands.
//   Hold      what has been received and not yet sent back to a supplier
//             or written off. Some of it does go back, so it cannot
//             simply disappear on receipt.
//
// The scanner is the input, not the keyboard. A barcode gun types into
// whatever field has focus and presses Enter, so the top field stays
// focused and every Enter resolves a code and adds a line. Typing a
// product name works too, for the piece whose barcode is the thing that
// got destroyed.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, fetchSellableItems, SellableItem, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";

type Line = {
  key: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  qty: number;
  reason: string;
};

type Pending = {
  damage_no: string;
  store_id: string;
  reported_by: string | null;
  created_at: string;
  lines: number;
  qty: number;
  value: number;
  items: { name: string; qty: number; reason: string | null }[];
};

type Holding = {
  warehouse_id: string | null;
  from_store_id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  sku: string | null;
  qty: number;
  value: number;
  oldest: string | null;
  lines: number;
};

const REASONS = [
  "Broken in transit",
  "Broken in store",
  "Expired",
  "Packaging damaged",
  "Customer return, unsellable",
  "Other",
];

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n || 0));

export default function StockDamagePage() {
  const { profile } = useAuth();
  const { storeId } = useStore();

  const [canFile, setCanFile] = useState(false);
  const [canReceive, setCanReceive] = useState(false);
  const [canDispose, setCanDispose] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [checking, setChecking] = useState(true);

  const [tab, setTab] = useState<"file" | "approve" | "receive" | "hold">("file");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // --- filing ------------------------------------------------------
  const [store, setStore] = useState(storeId || "");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<SellableItem[]>([]);
  const [code, setCode] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  // --- receiving ---------------------------------------------------
  const [pending, setPending] = useState<Pending[]>([]);
  const [unsigned, setUnsigned] = useState<Pending[]>([]);
  const [holding, setHolding] = useState<Holding[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [f, r, d, ap] = await Promise.all([
        supabase.rpc("can_file_damage"),
        supabase.rpc("can_receive_damage"),
        supabase.rpc("can_dispose_damage"),
        supabase.rpc("can_approve_damage"),
      ]);
      const file = !!f.data;
      const recv = !!r.data;
      setCanFile(file);
      setCanReceive(recv);
      setCanDispose(!!d.data);
      setCanApprove(!!ap.data);
      setTab(ap.data ? "approve" : file ? "file" : recv ? "receive" : "hold");
      setChecking(false);
    })();
  }, []);

  useEffect(() => {
    supabase
      .from("stores")
      .select("id, name")
      .order("id")
      .then(({ data }) => setStores(data || []));
  }, []);

  useEffect(() => {
    if (!store) return;
    fetchSellableItems(store).then(setItems).catch(() => setItems([]));
  }, [store]);

  // Two queues, same shape: what is waiting to be signed, and what has
  // been signed and is waiting for the goods to turn up.
  const loadQueue = useCallback(
    async (status: string, set: (p: Pending[]) => void) => {
      const { data, error } = await supabase
        .from("stock_damages")
        .select("damage_no, store_id, reported_by, created_at, qty, unit_cost, reason, product_id")
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) {
        setErr(describeError(error));
        return;
      }
      const names = new Map(items.map((i) => [i.product_id, i.display_name]));
      const byNo = new Map<string, Pending>();
      for (const r of data || []) {
        const no = r.damage_no || "—";
        let g = byNo.get(no);
        if (!g) {
          g = {
            damage_no: no,
            store_id: r.store_id,
            reported_by: r.reported_by,
            created_at: r.created_at,
            lines: 0,
            qty: 0,
            value: 0,
            items: [],
          };
          byNo.set(no, g);
        }
        g.lines += 1;
        g.qty += Number(r.qty || 0);
        g.value += Number(r.qty || 0) * Number(r.unit_cost || 0);
        g.items.push({
          name: names.get(r.product_id) || r.product_id,
          qty: Number(r.qty || 0),
          reason: r.reason,
        });
      }
      set([...byNo.values()]);
    },
    [items]
  );

  const loadUnsigned = useCallback(
    () => loadQueue("pending", setUnsigned),
    [loadQueue]
  );
  const loadPending = useCallback(
    () => loadQueue("approved", setPending),
    [loadQueue]
  );

  const loadHolding = useCallback(async () => {
    const { data, error } = await supabase
      .from("damage_holding_v")
      .select("*")
      .order("value", { ascending: false })
      .limit(1000);
    if (error) setErr(describeError(error));
    else setHolding((data || []) as Holding[]);
  }, []);

  useEffect(() => {
    if (tab === "approve") loadUnsigned();
    if (tab === "receive") loadPending();
    if (tab === "hold") loadHolding();
  }, [tab, loadUnsigned, loadPending, loadHolding]);

  // The count on the tab has to be right before the tab is opened.
  useEffect(() => {
    if (canApprove) loadUnsigned();
  }, [canApprove, loadUnsigned]);

  // -----------------------------------------------------------------
  // A scan, or a typed name. Anything the system knows as a code for
  // this product resolves; a name match is the fallback for the piece
  // whose label is gone.
  // -----------------------------------------------------------------
  const add = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      setErr(null);

      let found: SellableItem | undefined;

      const { data } = await supabase.rpc("resolve_barcode", { p_code: q });
      const hit = Array.isArray(data) ? data[0] : data;
      if (hit?.product_id) {
        found = items.find(
          (i) =>
            i.product_id === hit.product_id &&
            (hit.variant_id ? i.variant_id === hit.variant_id : true)
        );
      }
      if (!found) {
        const low = q.toLowerCase();
        const matches = items.filter(
          (i) =>
            (i.sku || "").toLowerCase() === low ||
            i.display_name.toLowerCase().includes(low)
        );
        if (matches.length === 1) found = matches[0];
        else if (matches.length > 1) {
          setErr(`${matches.length} items match "${q}" — scan the barcode or type more`);
          return;
        }
      }
      if (!found) {
        setErr(`Nothing found for "${q}"`);
        return;
      }

      const key = `${found.product_id}:${found.variant_id || ""}`;
      setLines((prev) => {
        const at = prev.findIndex((l) => l.key === key);
        if (at >= 0) {
          const next = [...prev];
          next[at] = { ...next[at], qty: next[at].qty + 1 };
          return next;
        }
        return [
          ...prev,
          {
            key,
            product_id: found!.product_id,
            variant_id: found!.variant_id || null,
            name: found!.display_name,
            sku: found!.sku || null,
            qty: 1,
            reason: REASONS[0],
          },
        ];
      });
      setCode("");
      scanRef.current?.focus();
    },
    [items]
  );

  const totalQty = useMemo(() => lines.reduce((s, l) => s + l.qty, 0), [lines]);

  async function submit() {
    setErr(null);
    setMsg(null);
    if (!store) return setErr("Choose the shop the goods are in");
    if (!lines.length) return setErr("Nothing to report");
    if (lines.some((l) => !(l.qty > 0))) return setErr("Every line needs a quantity");

    setSaving(true);
    const { data, error } = await supabase.rpc("create_stock_damage", {
      p_store_id: store,
      p_items: lines.map((l) => ({
        product_id: l.product_id,
        variant_id: l.variant_id,
        qty: l.qty,
        reason: l.reason,
      })),
      p_note: note || null,
    });
    setSaving(false);
    if (error) return setErr(describeError(error));
    setLines([]);
    setNote("");
    setMsg(`${data} sent to the warehouse — stock comes off when they receive it`);
    scanRef.current?.focus();
  }

  async function approve(no: string) {
    setErr(null);
    setMsg(null);
    setBusy(no);
    const { error } = await supabase.rpc("approve_stock_damage", { p_damage_no: no });
    setBusy(null);
    if (error) return setErr(describeError(error));
    setMsg(`${no} approved — the warehouse can take it in now`);
    loadUnsigned();
  }

  async function receive(no: string) {
    setErr(null);
    setMsg(null);
    setBusy(no);
    const { data, error } = await supabase.rpc("receive_stock_damage", {
      p_damage_no: no,
      p_to_store: null,
    });
    setBusy(null);
    if (error) return setErr(describeError(error));
    setMsg(`${no} received — ${data} lines, stock adjusted`);
    loadPending();
  }

  async function reject(no: string) {
    const why = window.prompt("Why is this being rejected?");
    if (!why) return;
    setErr(null);
    setBusy(no);
    const { error } = await supabase.rpc("reject_stock_damage", {
      p_damage_no: no,
      p_reason: why,
    });
    setBusy(null);
    if (error) return setErr(describeError(error));
    setMsg(`${no} rejected — no stock moved`);
    loadPending();
    loadUnsigned();
  }

  if (checking) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }

  if (!canFile && !canReceive && !canDispose && !canApprove) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold">Damage</h1>
        <p className="mt-2 text-sm text-gray-600">
          Damages are filed by the accounts department and received by the warehouse.
          Your account does neither — ask your manager if that is wrong.
        </p>
      </div>
    );
  }

  const tabs: { k: typeof tab; label: string; show: boolean }[] = [
    { k: "file", label: "File a damage", show: canFile },
    { k: "approve", label: `Waiting for approval${unsigned.length ? ` (${unsigned.length})` : ""}`, show: canApprove },
    { k: "receive", label: `Approved, to receive${pending.length ? ` (${pending.length})` : ""}`, show: canReceive },
    { k: "hold", label: "Held / to return", show: true },
  ];

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold">Damage</h1>
      <p className="mt-1 text-sm text-gray-500">
        Filed by accounts · received by the warehouse · stock comes off on receipt
      </p>

      <div className="mt-4 flex gap-2 border-b">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.k}
            onClick={() => { setTab(t.k); setErr(null); setMsg(null); }}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${
              tab === t.k
                ? "border-blue-600 text-blue-700 font-medium"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {err && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}
      {msg && (
        <div className="mt-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {msg}
        </div>
      )}

      {/* ---------------------------------------------------------- */}
      {tab === "file" && canFile && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-gray-600 mb-1">Shop the goods are in</span>
              <select
                value={store}
                onChange={(e) => { setStore(e.target.value); setLines([]); }}
                className="border rounded px-2 py-1.5 min-w-[12rem]"
              >
                <option value="">—</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <div className="text-sm text-gray-500 pb-2">
              Reported by {profile?.email || "—"}
            </div>
          </div>

          <div>
            <label className="text-sm block text-gray-600 mb-1">
              Scan each piece
            </label>
            <input
              ref={scanRef}
              autoFocus
              value={code}
              disabled={!store}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add(code);
                }
              }}
              placeholder={store ? "Barcode, SKU, or product name — then Enter" : "Choose a shop first"}
              className="w-full border rounded px-3 py-2 font-mono"
            />
            <p className="mt-1 text-xs text-gray-500">
              Scanning the same piece again adds one to its quantity.
            </p>
          </div>

          {lines.length > 0 && (
            <div className="overflow-x-auto border rounded">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2 w-24">Qty</th>
                    <th className="px-3 py-2 w-56">Reason</th>
                    <th className="px-3 py-2 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.key} className="border-t">
                      <td className="px-3 py-2">
                        <div>{l.name}</div>
                        {l.sku && <div className="text-xs text-gray-400 font-mono">{l.sku}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          value={l.qty}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setLines((p) => p.map((x, k) => (k === i ? { ...x, qty: v } : x)));
                          }}
                          className="w-20 border rounded px-2 py-1 text-right"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={l.reason}
                          onChange={(e) =>
                            setLines((p) => p.map((x, k) => (k === i ? { ...x, reason: e.target.value } : x)))
                          }
                          className="w-full border rounded px-2 py-1"
                        >
                          {REASONS.map((r) => <option key={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setLines((p) => p.filter((_, k) => k !== i))}
                          className="text-gray-400 hover:text-red-600"
                          title="Remove"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t">
                  <tr>
                    <td className="px-3 py-2 font-medium">{lines.length} lines</td>
                    <td className="px-3 py-2 font-medium text-right">{totalQty}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <label className="block text-sm">
            <span className="block text-gray-600 mb-1">Note for the warehouse (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border rounded px-3 py-2"
              placeholder="Who is bringing it over, when"
            />
          </label>

          <div className="flex items-center gap-3">
            <button
              onClick={submit}
              disabled={saving || !lines.length || !store}
              className="rounded bg-blue-600 px-4 py-2 text-white text-sm font-medium disabled:opacity-40"
            >
              {saving ? "Sending…" : "Send to warehouse"}
            </button>
            <span className="text-xs text-gray-500">
              Nothing comes off stock until the warehouse receives it.
            </span>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- */}
      {tab === "approve" && canApprove && (
        <div className="mt-5 space-y-3">
          <p className="text-sm text-gray-500">
            A damage is a loss. Nothing reaches the warehouse until it is signed.
          </p>
          {unsigned.length === 0 && <p className="text-sm text-gray-500">Nothing waiting.</p>}
          {unsigned.map((p) => (
            <div key={p.damage_no} className="border rounded p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-medium font-mono">{p.damage_no}</div>
                  <div className="text-xs text-gray-500">
                    {p.store_id} · {p.reported_by || "—"} ·{" "}
                    {new Date(p.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div>{p.qty} pcs · {p.lines} lines</div>
                  <div className="text-xs text-gray-500">{money(p.value)} at cost</div>
                </div>
              </div>

              <ul className="mt-2 text-sm text-gray-700 space-y-0.5">
                {p.items.map((it, i) => (
                  <li key={i}>
                    {it.qty} × {it.name}
                    {it.reason && <span className="text-gray-400"> — {it.reason}</span>}
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => approve(p.damage_no)}
                  disabled={busy === p.damage_no}
                  className="rounded bg-green-600 px-3 py-1.5 text-white text-sm disabled:opacity-40"
                >
                  {busy === p.damage_no ? "…" : "Approve"}
                </button>
                <button
                  onClick={() => reject(p.damage_no)}
                  disabled={busy === p.damage_no}
                  className="rounded border px-3 py-1.5 text-sm text-red-700 border-red-200 disabled:opacity-40"
                >
                  Refuse
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "receive" && canReceive && (
        <div className="mt-5 space-y-3">
          {pending.length === 0 && (
            <p className="text-sm text-gray-500">Nothing waiting.</p>
          )}
          {pending.map((p) => (
            <div key={p.damage_no} className="border rounded p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-medium font-mono">{p.damage_no}</div>
                  <div className="text-xs text-gray-500">
                    {p.store_id} · {p.reported_by || "—"} ·{" "}
                    {new Date(p.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="text-right text-sm">
                  <div>{p.qty} pcs · {p.lines} lines</div>
                  <div className="text-xs text-gray-500">{money(p.value)} at cost</div>
                </div>
              </div>

              <ul className="mt-2 text-sm text-gray-700 space-y-0.5">
                {p.items.map((it, i) => (
                  <li key={i}>
                    {it.qty} × {it.name}
                    {it.reason && <span className="text-gray-400"> — {it.reason}</span>}
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => receive(p.damage_no)}
                  disabled={busy === p.damage_no}
                  className="rounded bg-green-600 px-3 py-1.5 text-white text-sm disabled:opacity-40"
                >
                  {busy === p.damage_no ? "…" : "Received"}
                </button>
                <button
                  onClick={() => reject(p.damage_no)}
                  disabled={busy === p.damage_no}
                  className="rounded border px-3 py-1.5 text-sm text-red-700 border-red-200 disabled:opacity-40"
                >
                  Did not arrive
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------- */}
      {tab === "hold" && (
        <div className="mt-5">
          {holding.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing held.</p>
          ) : (
            <div className="overflow-x-auto border rounded">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">From</th>
                    <th className="px-3 py-2">At</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {holding.map((h, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2">
                        <div>{h.product_name || h.product_id}</div>
                        {h.sku && <div className="text-xs text-gray-400 font-mono">{h.sku}</div>}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{h.from_store_id}</td>
                      <td className="px-3 py-2 text-gray-600">{h.warehouse_id || "—"}</td>
                      <td className="px-3 py-2 text-right">{h.qty}</td>
                      <td className="px-3 py-2 text-right">{money(h.value)}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {h.oldest ? new Date(h.oldest).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t">
                  <tr>
                    <td colSpan={3} className="px-3 py-2 font-medium">Total held</td>
                    <td className="px-3 py-2 text-right font-medium">
                      {holding.reduce((s, h) => s + Number(h.qty), 0)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">
                      {money(holding.reduce((s, h) => s + Number(h.value), 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {canDispose && holding.length > 0 && (
            <p className="mt-3 text-xs text-gray-500">
              Sending these back to a supplier, or writing them off, is the next
              step to build — the figures above are what it will work from.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
