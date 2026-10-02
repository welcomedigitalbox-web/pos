"use client";

// Consignment, in four views of one ledger.
//
//   Stock      what is standing here, by product
//   Suppliers  the same thing totalled per supplier
//   Payable    what has sold and is therefore owed
//   Movements  every arrival, sale and return, in order
//
// They are tabs rather than pages because they answer the same question from
// four sides, and a person checking one usually wants another.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, describeError } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useLanguage } from "../language-context";

type Row = {
  supplier_id: string | null;
  supplier_name: string | null;
  product_id: string;
  variant_id: string | null;
  store_id: string;
  on_hand: number;
  sold_qty: number;
  returned_qty: number;
  damaged_qty: number;
  owed: number;
};

type StatementRow = {
  sold_on: string;
  product: string;
  store_id: string;
  qty: number;
  unit_cost: number;
  amount: number;
  kind: string;
};

type Entry = {
  id: string;
  kind: string;
  qty: number;
  unit_cost: number;
  amount_due: number;
  store_id: string;
  product_id: string;
  supplier_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

type Tab = "orders" | "stock" | "suppliers" | "payable" | "statement" | "movements";

type PoRow = {
  id: string;
  po_number: string;
  status: string;
  order_date: string | null;
  supplier_id: string | null;
  total: number;
};

const fmt = (n: number) => Math.round(n).toLocaleString() + " MMK";

export default function ConsignmentPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("stock");
  const [pos, setPos] = useState<PoRow[]>([]);
  const [newPo, setNewPo] = useState(false);
  const [poSupplier, setPoSupplier] = useState("");
  const [poDate, setPoDate] = useState("");
  const [poNote, setPoNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [suppliers, setSuppliers] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [allStores, setAllStores] = useState(true);
  const [toast, setToast] = useState("");

  const [back, setBack] = useState<Row | null>(null);
  const [backQty, setBackQty] = useState("");
  const [backNote, setBackNote] = useState("");
  const [sending, setSending] = useState(false);

  const [dmg, setDmg] = useState<Row | null>(null);
  const [dmgQty, setDmgQty] = useState("");
  const [dmgWho, setDmgWho] = useState<"shop" | "supplier" | "shared">("shop");
  const [dmgNote, setDmgNote] = useState("");

  const [stmtSupplier, setStmtSupplier] = useState("");
  const [stmtFrom, setStmtFrom] = useState("");
  const [stmtTo, setStmtTo] = useState("");
  const [stmt, setStmt] = useState<StatementRow[] | null>(null);

  useEffect(() => {
    if (profile && !hasPermission(profile, "products")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    supabase.rpc("can_approve_dept", { p_department: "merchandising" })
      .then(({ data }) => setCanApprove(!!data));
  }, []);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [storeId, allStores]);

  function showToast(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 4000);
  }

  async function load() {
    setLoading(true);
    let q = supabase.from("consignment_stock_v").select("*").limit(2000);
    if (!allStores) q = q.eq("store_id", storeId);
    const [{ data }, { data: prods }, { data: sups }, { data: log }, { data: poData }] = await Promise.all([
      q,
      supabase.from("products").select("id, name").limit(5000),
      supabase.from("suppliers").select("id, name").limit(2000),
      supabase.from("consignment_ledger")
        .select("id, kind, qty, unit_cost, amount_due, store_id, product_id, supplier_id, note, created_by, created_at")
        .order("created_at", { ascending: false }).limit(200),
      supabase.from("purchase_orders")
        .select("id, po_number, status, order_date, supplier_id, purchase_order_items(qty, unit_cost)")
        .eq("is_consignment", true)
        .order("created_at", { ascending: false }).limit(300),
    ]);
    setRows(((data as Row[]) || []).filter((r) => Number(r.on_hand) !== 0 || Number(r.sold_qty) > 0));
    const pm: Record<string, string> = {};
    for (const p of (prods as { id: string; name: string }[]) || []) pm[p.id] = p.name;
    setNames(pm);
    const sm: Record<string, string> = {};
    for (const s of (sups as { id: string; name: string }[]) || []) sm[s.id] = s.name;
    setSuppliers(sm);
    setEntries((log as Entry[]) || []);
    setPos(
      ((poData as (PoRow & { purchase_order_items: { qty: number; unit_cost: number }[] })[]) || [])
        .map((p) => ({
          ...p,
          total: (p.purchase_order_items || []).reduce((t, i) => t + Number(i.qty) * Number(i.unit_cost), 0),
        }))
    );
    setLoading(false);
  }

  const totals = useMemo(() => ({
    onHand: rows.reduce((s, r) => s + Number(r.on_hand), 0),
    owed: rows.reduce((s, r) => s + Number(r.owed), 0),
    sold: rows.reduce((s, r) => s + Number(r.sold_qty), 0),
  }), [rows]);

  // The same rows, gathered under whoever the goods belong to.
  const bySupplier = useMemo(() => {
    const m = new Map<string, { name: string; onHand: number; sold: number; returned: number; owed: number; lines: number }>();
    for (const r of rows) {
      const k = r.supplier_id || "?";
      const e = m.get(k) || {
        name: r.supplier_name || suppliers[k] || "—",
        onHand: 0, sold: 0, returned: 0, owed: 0, lines: 0,
      };
      e.onHand += Number(r.on_hand);
      e.sold += Number(r.sold_qty);
      e.returned += Number(r.returned_qty);
      e.owed += Number(r.owed);
      e.lines += 1;
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].owed - a[1].owed);
  }, [rows, suppliers]);

  // An order made from this page is a consignment order by construction. The
  // kind is not a box to tick: it is where you are standing.
  async function createPo(e: React.FormEvent) {
    e.preventDefault();
    if (!poSupplier) return;
    setCreating(true);
    try {
      const { data, error } = await supabase.from("purchase_orders").insert({
        po_number: `CO-${Date.now().toString().slice(-8)}`,
        supplier_id: poSupplier,
        payment_term: "credit",
        expected_date: poDate || null,
        note: poNote.trim() || null,
        is_consignment: true,
        created_by: profile?.email || null,
      }).select("id").single();
      if (error) throw error;
      router.push(`/purchase-orders/${data.id}`);
    } catch (err) {
      showToast("❌ " + describeError(err));
    } finally {
      setCreating(false);
    }
  }

  // Breakage, loss and theft. The question the function will not let anyone
  // skip is who carries it, because that is the only part that costs money.
  async function recordDamage() {
    if (!dmg) return;
    const qty = Number(dmgQty);
    if (!qty || qty <= 0) return showToast("❌ " + t("stockRequest_qtyInvalid"));
    if (!dmgNote.trim()) return showToast("❌ Say what happened");
    setSending(true);
    try {
      const { error } = await supabase.rpc("consignment_damage", {
        p_supplier: dmg.supplier_id,
        p_product: dmg.product_id,
        p_variant: dmg.variant_id,
        p_store: dmg.store_id,
        p_qty: qty,
        p_borne_by: dmgWho,
        p_note: dmgNote.trim(),
        p_shop_share: 0.5,
      });
      if (error) throw error;
      setDmg(null); setDmgQty(""); setDmgNote(""); setDmgWho("shop");
      showToast("✅");
      await load();
    } catch (err) {
      showToast("❌ " + describeError(err));
    } finally {
      setSending(false);
    }
  }

  async function runStatement() {
    if (!stmtSupplier || !stmtFrom || !stmtTo) return showToast("❌ supplier and dates");
    const { data, error } = await supabase.rpc("consignment_statement", {
      p_supplier: stmtSupplier, p_from: stmtFrom, p_to: stmtTo,
    });
    if (error) return showToast("❌ " + describeError(error));
    setStmt((data as StatementRow[]) || []);
  }

  async function sendBack() {
    if (!back) return;
    const qty = Number(backQty);
    if (!qty || qty <= 0) return showToast("❌ " + t("stockRequest_qtyInvalid"));
    setSending(true);
    try {
      const { error } = await supabase.rpc("consignment_return", {
        p_supplier: back.supplier_id,
        p_product: back.product_id,
        p_variant: back.variant_id,
        p_store: back.store_id,
        p_qty: qty,
        p_note: backNote.trim() || null,
      });
      if (error) throw error;
      setBack(null); setBackQty(""); setBackNote("");
      showToast("✅");
      await load();
    } catch (err) {
      showToast("❌ " + describeError(err));
    } finally {
      setSending(false);
    }
  }

  if (!profile || !hasPermission(profile, "products")) return null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "orders", label: t("nav_purchaseOrders") },
    { key: "stock", label: "Stock" },
    { key: "suppliers", label: t("nav_suppliers") },
    { key: "payable", label: t("suppliers_balance") },
    { key: "statement", label: "Statement" },
    { key: "movements", label: "Movements" },
  ];

  const th = "text-left px-4 py-2";
  const thr = "text-right px-4 py-2";
  const box = "bg-white border border-slate-200 rounded-xl overflow-x-auto";

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_consignment")}</h2>
        <label className="flex items-center gap-2 text-sm text-slate-500">
          <input type="checkbox" checked={allStores} onChange={(e) => setAllStores(e.target.checked)} />
          all stores
        </label>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Goods that belong to the supplier until they sell. Nothing is owed on
        what is still standing here.
      </p>

      <div className="flex flex-wrap gap-3 mb-4">
        <Tile label="Still here" value={String(totals.onHand)} />
        <Tile label="Sold" value={String(totals.sold)} />
        <Tile label="Owed" value={fmt(totals.owed)} tone="text-orange-600" />
      </div>

      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {tabs.map((x) => (
          <button key={x.key} onClick={() => setTab(x.key)}
            className={
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px " +
              (tab === x.key
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-700")
            }>
            {x.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-slate-400">…</p>}

      {!loading && tab === "orders" && (
        <>
          {canApprove && pos.filter((p) => p.status === "draft").length > 0 && (
            <div className="mb-3 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-800">
              <span className="w-5 h-5 rounded-full bg-amber-500 text-white text-xs font-semibold flex items-center justify-center">
                {pos.filter((p) => p.status === "draft").length}
              </span>
              waiting for your approval
            </div>
          )}

          <div className="flex justify-between items-center mb-3">
            <p className="text-sm text-slate-500">
              Orders for goods taken on consignment. Nothing on them is owed
              until the goods sell.
            </p>
            <button onClick={() => setNewPo(true)}
              className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium shrink-0">
              + {t("po_addNew")}
            </button>
          </div>
          <div className={box}>
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className={th}>{t("po_number")}</th>
                  <th className={th}>{t("nav_suppliers")}</th>
                  <th className={th}>{t("po_orderDate")}</th>
                  <th className={thr}>{t("pos_total")}</th>
                  <th className={th}>{t("saleOrder_status")}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {[...pos]
                  .sort((a, b) => (a.status === "draft" ? 0 : 1) - (b.status === "draft" ? 0 : 1))
                  .map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium">{p.po_number}</td>
                    <td className="px-4 py-2 text-slate-500">{suppliers[p.supplier_id || ""] || "-"}</td>
                    <td className="px-4 py-2 text-slate-500">{p.order_date || "-"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(p.total)}</td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                        {t(`po_status_${p.status}` as never)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <a href={`/purchase-orders/${p.id}`} className="text-blue-600 text-xs font-medium">
                        {t("products_view")}
                      </a>
                    </td>
                  </tr>
                ))}
                {pos.length === 0 && (
                  <tr><td colSpan={6} className="text-center text-slate-400 py-10">
                    No consignment orders yet
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!loading && tab === "stock" && (
        <div className={box}>
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className={th}>{t("customers_name")}</th>
                <th className={th}>{t("nav_suppliers")}</th>
                {allStores && <th className={th}>Store</th>}
                <th className={thr}>Here</th>
                <th className={thr}>Sold</th>
                <th className={thr}>Returned</th>
                <th className={thr}>Damaged</th>
                <th className={thr}>Owed</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium">{names[r.product_id] || r.product_id.slice(0, 8)}</td>
                  <td className="px-4 py-2 text-slate-500">{r.supplier_name || "-"}</td>
                  {allStores && <td className="px-4 py-2 text-slate-500">{r.store_id}</td>}
                  <td className="px-4 py-2 text-right tabular-nums">{Number(r.on_hand)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{Number(r.sold_qty)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400">{Number(r.returned_qty)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-red-500">{Number(r.damaged_qty || 0)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-orange-600">{fmt(Number(r.owed))}</td>
                  <td className="px-4 py-2 text-right">
                    {Number(r.on_hand) > 0 && (
                      <span className="space-x-3 whitespace-nowrap">
                        <button onClick={() => { setBack(r); setBackQty(String(r.on_hand)); }}
                          className="text-blue-600 text-xs font-medium">Send back</button>
                        <button onClick={() => { setDmg(r); setDmgQty("1"); }}
                          className="text-red-600 text-xs font-medium">Damaged</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="text-center text-slate-400 py-10">
                  Nothing on consignment
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && tab === "suppliers" && (
        <div className={box}>
          <table className="w-full text-sm min-w-[620px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className={th}>{t("nav_suppliers")}</th>
                <th className={thr}>Products</th>
                <th className={thr}>Here</th>
                <th className={thr}>Sold</th>
                <th className={thr}>Returned</th>
                <th className={thr}>Damaged</th>
                <th className={thr}>Owed</th>
              </tr>
            </thead>
            <tbody>
              {bySupplier.map(([id, s]) => (
                <tr key={id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium">{s.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{s.lines}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{s.onHand}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{s.sold}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-400">{s.returned}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-orange-600">{fmt(s.owed)}</td>
                </tr>
              ))}
              {bySupplier.length === 0 && (
                <tr><td colSpan={6} className="text-center text-slate-400 py-10">-</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && tab === "payable" && (
        <>
          <p className="text-sm text-slate-500 mb-3">
            Only what has sold. Goods still on the shelf are the supplier&apos;s,
            and appear here the day a customer buys one.
          </p>
          <div className={box}>
            <table className="w-full text-sm min-w-[620px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className={th}>Date</th>
                  <th className={th}>{t("customers_name")}</th>
                  <th className={th}>{t("nav_suppliers")}</th>
                  <th className={thr}>Qty</th>
                  <th className={thr}>{t("suppliers_balance")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.filter((e) => e.kind === "sold").map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-500">{e.created_at.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-4 py-2">{names[e.product_id] || e.note || "-"}</td>
                    <td className="px-4 py-2 text-slate-500">{suppliers[e.supplier_id || ""] || "-"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(e.qty)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-orange-600">
                      {fmt(Number(e.amount_due))}
                    </td>
                  </tr>
                ))}
                {entries.filter((e) => e.kind === "sold").length === 0 && (
                  <tr><td colSpan={5} className="text-center text-slate-400 py-10">
                    Nothing sold on consignment yet
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!loading && tab === "statement" && (
        <>
          <p className="text-sm text-slate-500 mb-3">
            What sold in a period, for the supplier to invoice. Returns appear
            as negatives; damage the shop agreed to carry appears as a charge.
          </p>
          <div className="flex flex-wrap items-end gap-2 mb-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1">{t("nav_suppliers")}</label>
              <select value={stmtSupplier} onChange={(e) => setStmtSupplier(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm">
                <option value="">{t("stockIn_selectPlaceholder")}</option>
                {Object.entries(suppliers).map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">From</label>
              <input type="date" value={stmtFrom} onChange={(e) => setStmtFrom(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">To</label>
              <input type="date" value={stmtTo} onChange={(e) => setStmtTo(e.target.value)}
                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            </div>
            <button onClick={runStatement}
              className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
              Show
            </button>
            {stmt && stmt.length > 0 && (
              <button onClick={() => window.print()}
                className="border border-slate-200 text-sm px-4 py-2 rounded-lg font-medium print:hidden">
                🖨
              </button>
            )}
          </div>

          {stmt && (
            <div className={box}>
              <table className="w-full text-sm min-w-[700px]">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className={th}>Date</th>
                    <th className={th}>{t("customers_name")}</th>
                    <th className={th}>Store</th>
                    <th className={thr}>Qty</th>
                    <th className={thr}>{t("products_avgCost")}</th>
                    <th className={thr}>{t("pos_total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stmt.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-4 py-2 text-slate-500">{r.sold_on}</td>
                      <td className="px-4 py-2">
                        {r.product}
                        {r.kind !== "sold" && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                            {r.kind === "returned_by_customer" ? "returned" : r.kind}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-500">{r.store_id}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{Number(r.qty)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmt(Number(r.unit_cost))}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(Number(r.amount))}</td>
                    </tr>
                  ))}
                  {stmt.length === 0 && (
                    <tr><td colSpan={6} className="text-center text-slate-400 py-10">
                      Nothing sold in that period
                    </td></tr>
                  )}
                </tbody>
                {stmt.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 font-semibold">
                      <td className="px-4 py-2" colSpan={5}>{t("pos_total")}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-orange-600">
                        {fmt(stmt.reduce((t2, r) => t2 + Number(r.amount), 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </>
      )}

      {!loading && tab === "movements" && (
        <div className={box}>
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className={th}>Date</th>
                <th className={th}>What</th>
                <th className={th}>{t("customers_name")}</th>
                <th className={th}>Store</th>
                <th className={thr}>Qty</th>
                <th className={thr}>Owed</th>
                <th className={th}>{t("pos_note")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-500">{e.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-4 py-2">
                    <span className={
                      "px-2 py-0.5 rounded text-xs font-medium " +
                      (e.kind === "sold" ? "bg-orange-100 text-orange-700"
                        : e.kind === "returned" ? "bg-slate-100 text-slate-600"
                        : "bg-green-100 text-green-700")
                    }>{e.kind}</span>
                  </td>
                  <td className="px-4 py-2">{names[e.product_id] || "-"}</td>
                  <td className="px-4 py-2 text-slate-500">{e.store_id}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(e.qty)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {Number(e.amount_due) ? fmt(Number(e.amount_due)) : "-"}
                  </td>
                  <td className="px-4 py-2 text-slate-400">{e.note || e.created_by || "-"}</td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr><td colSpan={7} className="text-center text-slate-400 py-10">-</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {newPo && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={createPo} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("po_addNew")}</h3>
            <p className="text-xs text-slate-500 mb-4">
              The goods stay the supplier&apos;s until they sell.
            </p>

            <label className="text-sm text-slate-600">{t("nav_suppliers")}</label>
            <select required value={poSupplier} onChange={(e) => setPoSupplier(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3">
              <option value="">{t("stockIn_selectPlaceholder")}</option>
              {Object.entries(suppliers).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("po_expectedDate")}</label>
            <input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" />

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <input value={poNote} onChange={(e) => setPoNote(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4" />

            <div className="flex gap-2">
              <button type="button" onClick={() => setNewPo(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button type="submit" disabled={creating}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {creating ? "..." : t("products_save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {dmg && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">Damaged or lost</h3>
            <p className="text-sm text-slate-500 mb-4">
              {names[dmg.product_id]} · {dmg.supplier_name} · {Number(dmg.on_hand)} here
            </p>

            <label className="text-sm text-slate-600">Quantity</label>
            <input type="number" autoFocus value={dmgQty} onChange={(e) => setDmgQty(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" />

            <label className="text-sm text-slate-600">Who carries it</label>
            <div className="flex gap-2 mt-1 mb-1">
              {([["shop", "We buy it"], ["supplier", "Supplier"], ["shared", "Shared 50/50"]] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setDmgWho(k)}
                  className={
                    "flex-1 py-2 rounded-lg text-xs font-medium border " +
                    (dmgWho === k ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200")
                  }>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 mb-3">
              {dmgWho === "shop" && "The supplier is owed for these units."}
              {dmgWho === "supplier" && "Nothing is owed; tell the supplier."}
              {dmgWho === "shared" && "Half the cost is owed."}
            </p>

            <label className="text-sm text-slate-600">What happened *</label>
            <input value={dmgNote} onChange={(e) => setDmgNote(e.target.value)}
              placeholder="dropped in the stockroom"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4" />

            <div className="flex gap-2">
              <button onClick={() => setDmg(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={recordDamage} disabled={sending}
                className="flex-1 py-2.5 bg-red-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {sending ? "..." : "Record"}
              </button>
            </div>
          </div>
        </div>
      )}

      {back && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">Send back</h3>
            <p className="text-sm text-slate-500 mb-4">
              {names[back.product_id]} · {back.supplier_name} · {Number(back.on_hand)} here
            </p>

            <label className="text-sm text-slate-600">Quantity</label>
            <input type="number" autoFocus value={backQty} onChange={(e) => setBackQty(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" />

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <input value={backNote} onChange={(e) => setBackNote(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4" />

            <div className="flex gap-2">
              <button onClick={() => setBack(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={sendBack} disabled={sending}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {sending ? "..." : "Send back"}
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

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 min-w-[130px]">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={"text-lg font-semibold mt-0.5 " + (tone || "")}>{value}</div>
    </div>
  );
}
