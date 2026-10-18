"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";

// Supabase hands back a plain object, so String() on it prints "[object Object]"
// and the cashier learns nothing. Pull the real message out.
function errText(err: unknown) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: string; details?: string; hint?: string };
    return e.message || e.details || e.hint || JSON.stringify(err);
  }
  return String(err);
}

function fmt(n: number) {
  return Math.round(Number(n) || 0).toLocaleString() + " MMK";
}

// The supplier's own bill. The order said what to buy and the warehouse said
// what turned up; this says what is owed. It never moves stock, and one order
// can be billed several times as it arrives in parts.
type Supplier = { id: string; name: string };

type PO = { id: string; po_number: string; supplier_id: string | null };

type ToBill = {
  po_item_id: string;
  po_id: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  ordered_qty: number;
  received_qty: number;
  billed_qty: number;
  to_bill_qty: number;
  unit_cost: number;
};

type Line = {
  po_item_id: string | null;
  product_id: string | null;
  variant_id: string | null;
  description: string;
  qty: string;
  unit_cost: string;
};

type Bill = {
  id: string;
  internal_no: string;
  invoice_no: string;
  po_id: string | null;
  supplier_id: string;
  store_id: string;
  invoice_date: string;
  due_date: string | null;
  total: number;
  status: string;
  decision_note: string | null;
  decided_by: string | null;
  created_by: string | null;
};

const STATUS_CLASS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  submitted: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

export default function PurchaseInvoicesPage() {
  const { profile } = useAuth();
  const { stores } = useStore();
  const router = useRouter();

  const [bills, setBills] = useState<Bill[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [pos, setPos] = useState<PO[]>([]);
  const [tab, setTab] = useState<"open" | "approved" | "rejected">("open");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [form, setForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [poId, setPoId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [taxPercent, setTaxPercent] = useState("0");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !hasPermission(profile, "purchase-orders")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    supabase
      .from("suppliers")
      .select("id,name")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setSuppliers((data as Supplier[]) || []));
    supabase
      .from("purchase_orders")
      .select("id,po_number,supplier_id")
      .order("created_at", { ascending: false })
      .limit(300)
      .then(({ data }) => setPos((data as PO[]) || []));
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Arriving from a purchase order: open a fresh bill with that order already
  // chosen, so the lines are there before anyone starts typing.
  const params = useSearchParams();
  const fromPo = params.get("po");
  const [cameFromPo, setCameFromPo] = useState(false);
  useEffect(() => {
    if (!fromPo || cameFromPo || pos.length === 0) return;
    setCameFromPo(true);
    newBill();
    pickPo(fromPo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromPo, pos.length]);

  if (!profile || !hasPermission(profile, "purchase-orders")) return null;

  async function load() {
    setLoading(true);
    let q = supabase
      .from("purchase_invoices")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    if (tab === "open") q = q.in("status", ["draft", "submitted"]);
    else q = q.eq("status", tab);
    const { data, error } = await q;
    if (error) showToast("❌ " + error.message);
    setBills((data as Bill[]) || []);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  function supplierName(id: string | null) {
    return suppliers.find((s) => s.id === id)?.name || "-";
  }

  function newBill() {
    setEditId(null);
    setInvoiceNo("");
    setPoId("");
    setSupplierId("");
    setStoreId(stores[0]?.id || "");
    setInvoiceDate(new Date().toISOString().slice(0, 10));
    setDueDate("");
    setTaxPercent("0");
    setNote("");
    setLines([]);
    setForm(true);
  }

  // Picking the order fills the bill with whatever is still unbilled on it,
  // which is what the supplier is almost always billing for.
  async function pickPo(id: string) {
    setPoId(id);
    if (!id) return;
    const po = pos.find((p) => p.id === id);
    if (po?.supplier_id) setSupplierId(po.supplier_id);
    const { data } = await supabase
      .from("po_lines_to_bill")
      .select("*")
      .eq("po_id", id);
    const rows = ((data as ToBill[]) || []).filter((r) => Number(r.to_bill_qty) > 0);
    setLines(
      rows.map((r) => ({
        po_item_id: r.po_item_id,
        product_id: r.product_id,
        variant_id: r.variant_id,
        description: r.name,
        qty: String(r.to_bill_qty),
        unit_cost: String(r.unit_cost ?? 0),
      }))
    );
  }

  async function openBill(b: Bill) {
    setEditId(b.id);
    setInvoiceNo(b.invoice_no);
    setPoId(b.po_id || "");
    setSupplierId(b.supplier_id);
    setStoreId(b.store_id);
    setInvoiceDate(b.invoice_date);
    setDueDate(b.due_date || "");
    setNote("");
    const { data } = await supabase
      .from("purchase_invoice_items")
      .select("*")
      .eq("invoice_id", b.id)
      .order("line_no");
    setLines(
      ((data as Record<string, unknown>[]) || []).map((r) => ({
        po_item_id: (r.po_item_id as string) ?? null,
        product_id: (r.product_id as string) ?? null,
        variant_id: (r.variant_id as string) ?? null,
        description: String(r.description ?? ""),
        qty: String(r.qty ?? ""),
        unit_cost: String(r.unit_cost ?? ""),
      }))
    );
    setForm(true);
  }

  function setLine(i: number, patch: Partial<Line>) {
    setLines((old) => old.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  }

  const subtotal = lines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0),
    0
  );
  const taxAmount = (subtotal * (Number(taxPercent) || 0)) / 100;
  const total = subtotal + taxAmount;

  async function save(thenSubmit: boolean) {
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("save_purchase_invoice", {
        p: {
          id: editId,
          invoice_no: invoiceNo.trim(),
          po_id: poId || null,
          supplier_id: supplierId,
          store_id: storeId,
          invoice_date: invoiceDate,
          due_date: dueDate || null,
          tax_percent: Number(taxPercent) || 0,
          note: note.trim() || null,
          items: lines
            .filter((l) => Number(l.qty) > 0)
            .map((l) => ({
              po_item_id: l.po_item_id,
              product_id: l.product_id,
              variant_id: l.variant_id,
              description: l.description,
              qty: Number(l.qty),
              unit_cost: Number(l.unit_cost),
            })),
        },
      });
      if (error) throw error;
      const id = data as string;
      if (thenSubmit) {
        const { error: subErr } = await supabase.rpc("submit_purchase_invoice", {
          p_id: id,
        });
        if (subErr) throw subErr;
        showToast("Sent to finance");
      } else {
        showToast("Saved as a draft");
      }
      setForm(false);
      await load();
    } catch (err) {
      showToast("❌ " + errText(err));
    } finally {
      setSaving(false);
    }
  }

  async function reopen(b: Bill) {
    const { error } = await supabase.rpc("reopen_purchase_invoice", { p_id: b.id });
    if (error) return showToast("❌ " + error.message);
    await load();
  }

  return (
    <div className="pt-4">
      <div className="flex items-start justify-between mb-1">
        <h2 className="font-semibold text-lg">Supplier bills</h2>
        <button
          onClick={newBill}
          className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium"
        >
          + New bill
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        What the supplier is charging. Stock moves when the warehouse receives
        the goods, not here. Finance checks the bill and pays it.
      </p>

      <div className="flex items-center gap-2 mb-4">
        {(["open", "approved", "rejected"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
              tab === k ? "bg-slate-900 text-white" : "border border-slate-200"
            }`}
          >
            {k === "open" ? "Draft & waiting" : k === "approved" ? "Approved" : "Turned down"}
          </button>
        ))}
        <span className="ml-auto text-sm text-slate-500">{bills.length}</span>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Ref</th>
              <th className="text-left px-3 py-2">Supplier bill no</th>
              <th className="text-left px-3 py-2">Supplier</th>
              <th className="text-left px-3 py-2">Order</th>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-right px-3 py-2">Total</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="text-center text-slate-400 py-8">
                  ...
                </td>
              </tr>
            )}
            {!loading &&
              bills.map((b) => (
                <tr key={b.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{b.internal_no}</td>
                  <td className="px-3 py-2 font-medium">{b.invoice_no}</td>
                  <td className="px-3 py-2">{supplierName(b.supplier_id)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {pos.find((p) => p.id === b.po_id)?.po_number || "-"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{b.invoice_date}</td>
                  <td className="px-3 py-2 text-right font-semibold">{fmt(b.total)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_CLASS[b.status] || ""
                      }`}
                    >
                      {b.status}
                    </span>
                    {b.decision_note && (
                      <div className="text-[10px] text-red-600 mt-0.5">{b.decision_note}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {b.status === "draft" && (
                      <button
                        onClick={() => openBill(b)}
                        className="text-blue-600 text-xs font-semibold"
                      >
                        Open
                      </button>
                    )}
                    {b.status === "rejected" && (
                      <button
                        onClick={() => reopen(b)}
                        className="text-blue-600 text-xs font-semibold"
                      >
                        Reopen
                      </button>
                    )}
                    {b.status === "submitted" && (
                      <span className="text-xs text-slate-400">With finance</span>
                    )}
                    {b.status === "approved" && (
                      <span className="text-xs text-green-700">{b.decided_by}</span>
                    )}
                  </td>
                </tr>
              ))}
            {!loading && bills.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-400 py-8">
                  -
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-3xl shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-4">
              {editId ? "Edit bill" : "New supplier bill"}
            </h3>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-sm text-slate-600">Against which order</label>
                <select
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={poId}
                  onChange={(e) => pickPo(e.target.value)}
                >
                  <option value="">No order (direct purchase)</option>
                  {pos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.po_number}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-600">Supplier *</label>
                <select
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">-</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-600">Supplier&rsquo;s bill number *</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  placeholder="INV-00123"
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm text-slate-600">Goods came into *</label>
                <select
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                >
                  <option value="">-</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-600">Bill date</label>
                <input
                  type="date"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm text-slate-600">Due date</label>
                <input
                  type="date"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-x-auto mb-3">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2">Item</th>
                    <th className="text-right px-3 py-2 w-24">Qty</th>
                    <th className="text-right px-3 py-2 w-32">Unit cost</th>
                    <th className="text-right px-3 py-2 w-32">Line</th>
                    <th className="px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <input
                          className="w-full border border-slate-200 rounded px-2 py-1"
                          value={l.description}
                          onChange={(e) => setLine(i, { description: e.target.value })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          className="w-full border border-slate-200 rounded px-2 py-1 text-right"
                          value={l.qty}
                          onChange={(e) => setLine(i, { qty: e.target.value })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {/* Against an order the cost is the order's cost.
                            The database enforces it too; this only saves
                            somebody typing a figure that will be refused. */}
                        <input
                          type="number"
                          className="w-full border border-slate-200 rounded px-2 py-1 text-right"
                          value={l.unit_cost}
                          readOnly={!!poId && !!l.po_item_id}
                          style={poId && l.po_item_id ? { background: "#f8fafc", color: "#64748b" } : undefined}
                          onChange={(e) => setLine(i, { unit_cost: e.target.value })}
                        />
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {fmt((Number(l.qty) || 0) * (Number(l.unit_cost) || 0))}
                      </td>
                      <td className="px-2 text-right">
                        <button
                          onClick={() => setLines(lines.filter((_, k) => k !== i))}
                          className="text-slate-400 text-xs"
                        >
                          remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-center text-slate-400 py-6">
                        Pick an order above, or add a line by hand.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <button
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    po_item_id: null,
                    product_id: null,
                    variant_id: null,
                    description: "",
                    qty: "1",
                    unit_cost: "0",
                  },
                ])
              }
              className="text-xs text-blue-600 font-medium mb-4"
            >
              + Add a line
            </button>

            <div className="flex items-end gap-3 mb-4">
              <div className="w-32">
                <label className="text-sm text-slate-600">Tax %</label>
                <input
                  type="number"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={taxPercent}
                  onChange={(e) => setTaxPercent(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <label className="text-sm text-slate-600">Note</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">
                  {fmt(subtotal)} + {fmt(taxAmount)}
                </div>
                <div className="text-lg font-bold">{fmt(total)}</div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => save(false)}
                disabled={saving}
                className="flex-1 py-2.5 border border-slate-300 disabled:text-slate-300 rounded-lg text-sm font-semibold"
              >
                Save draft
              </button>
              <button
                onClick={() => save(true)}
                disabled={saving}
                className="flex-1 py-2.5 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold"
              >
                {saving ? "..." : "Send to finance"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
