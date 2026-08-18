"use client";

import { useEffect, useState } from "react";
import { supabase, logActivity } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type Session = {
  id: string;
  store_id: string;
  opening_amount: number;
  opened_by: string | null;
  opened_at: string;
  counted_amount: number | null;
  expected_amount: number | null;
  variance: number | null;
  closed_by: string | null;
  closed_at: string | null;
  note: string | null;
  status: "open" | "closed";
};

type Movement = {
  id: string;
  direction: "in" | "out";
  amount: number;
  reason: string;
  created_by: string | null;
  created_at: string;
};

export default function CashDrawerPage() {
  const { storeId, stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [history, setHistory] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  // Live figures for the open shift
  const [cashSales, setCashSales] = useState(0);
  const [cashRefunds, setCashRefunds] = useState(0);
  const [byMethod, setByMethod] = useState<{ method: string; sales: number; refunds: number; orders: number }[]>([]);

  const [showOpen, setShowOpen] = useState(false);
  const [openingAmount, setOpeningAmount] = useState("");

  const [showMove, setShowMove] = useState(false);
  const [moveDir, setMoveDir] = useState<"in" | "out">("out");
  const [moveAmount, setMoveAmount] = useState("");
  const [moveReason, setMoveReason] = useState("");

  const [showClose, setShowClose] = useState(false);
  const [countedAmount, setCountedAmount] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [zReport, setZReport] = useState<Session | null>(null);

  useEffect(() => {
    if (profile && !hasPermission(profile, "cash-drawer")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "cash-drawer")) return null;

  async function load() {
    setLoading(true);

    const { data: openRow } = await supabase
      .from("cash_drawer_sessions")
      .select("*")
      .eq("store_id", storeId)
      .eq("status", "open")
      .maybeSingle();

    const current = (openRow as Session) || null;
    setSession(current);

    if (current) {
      const { data: moves } = await supabase
        .from("cash_movements")
        .select("*")
        .eq("session_id", current.id)
        .order("created_at", { ascending: false });
      setMovements((moves as Movement[]) || []);

      // Only cash counts toward the till — card and wallet payments never
      // touch the drawer
      const { data: sales } = await supabase
        .from("sales")
        .select("total, payment_method")
        .eq("store_id", storeId)
        .gte("created_at", current.opened_at);
      const saleRows = (sales as any[]) || [];
      setCashSales(
        saleRows
          .filter((s) => (s.payment_method || "").toLowerCase() === "cash")
          .reduce((sum, s) => sum + Number(s.total), 0)
      );

      // Every tender, not just cash — the till only holds cash, but the shift
      // total has to reconcile against KPay, Wave and card slips too
      const methodMap = new Map<string, { sales: number; refunds: number; orders: number }>();
      for (const s of saleRows) {
        const m = (s.payment_method || "unknown").toLowerCase();
        const cur = methodMap.get(m) || { sales: 0, refunds: 0, orders: 0 };
        cur.sales += Number(s.total);
        cur.orders += 1;
        methodMap.set(m, cur);
      }

      // A refund handled here leaves this till, even when another branch made
      // the original sale
      const { data: refunds } = await supabase
        .from("sale_returns")
        .select("refund_amount, refund_method, refund_payment_method, processed_store_id, store_id, approved_at, status")
        .eq("status", "approved")
        .gte("approved_at", current.opened_at);
      const refundRows = ((refunds as any[]) || []).filter(
        (r) => (r.processed_store_id || r.store_id) === storeId && r.refund_method === "cash"
      );

      setCashRefunds(
        refundRows
          .filter((r) => (r.refund_payment_method || "cash").toLowerCase() === "cash")
          .reduce((sum, r) => sum + Number(r.refund_amount), 0)
      );

      for (const r of refundRows) {
        const m = (r.refund_payment_method || "cash").toLowerCase();
        const cur = methodMap.get(m) || { sales: 0, refunds: 0, orders: 0 };
        cur.refunds += Number(r.refund_amount);
        methodMap.set(m, cur);
      }

      setByMethod(
        Array.from(methodMap.entries())
          .map(([method, v]) => ({ method, ...v }))
          .sort((a, b) => b.sales - a.sales)
      );
    } else {
      setMovements([]);
      setCashSales(0);
      setCashRefunds(0);
      setByMethod([]);
    }

    const { data: past } = await supabase
      .from("cash_drawer_sessions")
      .select("*")
      .eq("store_id", storeId)
      .eq("status", "closed")
      .order("closed_at", { ascending: false })
      .limit(30);
    setHistory((past as Session[]) || []);

    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  const movedIn = movements.filter((m) => m.direction === "in").reduce((s, m) => s + Number(m.amount), 0);
  const movedOut = movements.filter((m) => m.direction === "out").reduce((s, m) => s + Number(m.amount), 0);
  const expected = session
    ? Number(session.opening_amount) + cashSales + movedIn - cashRefunds - movedOut
    : 0;
  const counted = Number(countedAmount || 0);
  const variance = counted - expected;

  function printZReport(row: Session) {
    setZReport(row);
    // Give the hidden report a tick to mount, then apply the till-roll size
    setTimeout(() => {
      const style = document.createElement("style");
      style.textContent = "@page { size: 80mm auto; margin: 0; }";
      document.head.appendChild(style);
      window.print();
      setTimeout(() => {
        style.remove();
        setZReport(null);
      }, 500);
    }, 300);
  }

  async function openDrawer() {
    const amt = Number(openingAmount);
    if (isNaN(amt) || amt < 0) return showToast(t("drawer_invalidAmount"));
    setSaving(true);
    try {
      const { error } = await supabase.from("cash_drawer_sessions").insert({
        store_id: storeId,
        opening_amount: amt,
        opened_by: profile?.email || null,
      });
      if (error) throw error;
      showToast(t("drawer_opened"));
      setShowOpen(false);
      setOpeningAmount("");
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function addMovement() {
    if (!session) return;
    const amt = Number(moveAmount);
    if (!amt || amt <= 0) return showToast(t("drawer_invalidAmount"));
    if (!moveReason.trim()) return showToast(t("drawer_reasonRequired"));

    setSaving(true);
    try {
      const { error } = await supabase.from("cash_movements").insert({
        session_id: session.id,
        direction: moveDir,
        amount: amt,
        reason: moveReason.trim(),
        created_by: profile?.email || null,
      });
      if (error) throw error;
      showToast(t("drawer_movementAdded"));
      setShowMove(false);
      setMoveAmount("");
      setMoveReason("");
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function closeDrawer() {
    if (!session) return;
    if (countedAmount.trim() === "") return showToast(t("drawer_countRequired"));
    // A gap either way needs explaining, not just a shortfall
    if (Math.abs(variance) > 0.5 && !closeNote.trim())
      return showToast(t("drawer_varianceNoteRequired"));

    setSaving(true);
    try {
      const { error } = await supabase
        .from("cash_drawer_sessions")
        .update({
          counted_amount: counted,
          expected_amount: expected,
          variance,
          closed_by: profile?.email || null,
          closed_at: new Date().toISOString(),
          note: closeNote.trim() || null,
          status: "closed",
        })
        .eq("id", session.id);
      if (error) throw error;

      await logActivity({
        entityType: "cash_drawer",
        entityId: session.id,
        action: "closed",
        detail: `${t("drawer_expected")} ${fmt(expected)} · ${t("drawer_counted")} ${fmt(counted)} · ${t("drawer_variance")} ${fmt(variance)}`,
        actor: profile?.email,
      });

      showToast(t("drawer_closed"));
      if (confirm(t("drawer_printZConfirm"))) {
        printZReport({
          ...session,
          counted_amount: counted,
          expected_amount: expected,
          variance,
          closed_at: new Date().toISOString(),
          closed_by: profile?.email || null,
          note: closeNote.trim() || null,
          status: "closed",
        });
      }
      setShowClose(false);
      setCountedAmount("");
      setCloseNote("");
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  const storeName = stores.find((s) => s.id === storeId)?.name || storeId;

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_cashDrawer")}</h2>
        {!loading &&
          (session ? (
            <div className="flex gap-2">
              <button onClick={() => { setMoveDir("out"); setShowMove(true); }}
                className="border border-slate-200 text-sm px-3 py-2 rounded-lg font-medium">
                {t("drawer_addMovement")}
              </button>
              <button onClick={() => { setShowClose(true); setCountedAmount(""); setCloseNote(""); }}
                className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
                {t("drawer_close")}
              </button>
            </div>
          ) : (
            <button onClick={() => setShowOpen(true)}
              className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
              {t("drawer_open")}
            </button>
          ))}
      </div>
      <p className="text-sm text-slate-500 mb-4">{storeName} · {t("drawer_subtitle")}</p>

      {loading && <div className="text-slate-400 py-8 text-center">...</div>}

      {!loading && !session && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-500">
          {t("drawer_noOpenSession")}
        </div>
      )}

      {!loading && session && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs text-slate-500 uppercase">{t("drawer_opening")}</div>
              <div className="text-lg font-bold mt-1">{fmt(Number(session.opening_amount))}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs text-slate-500 uppercase">{t("drawer_cashSales")}</div>
              <div className="text-lg font-bold mt-1 text-green-700">+{fmt(cashSales)}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs text-slate-500 uppercase">{t("drawer_cashRefunds")}</div>
              <div className="text-lg font-bold mt-1 text-red-600">-{fmt(cashRefunds)}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-xs text-slate-500 uppercase">{t("drawer_movements")}</div>
              <div className="text-sm font-bold mt-1">
                <span className="text-green-700">+{fmt(movedIn)}</span>{" "}
                <span className="text-red-600">-{fmt(movedOut)}</span>
              </div>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
              <div className="text-xs text-blue-700 uppercase">{t("drawer_expected")}</div>
              <div className="text-lg font-bold mt-1 text-blue-700">{fmt(expected)}</div>
            </div>
          </div>

          <p className="text-xs text-slate-400 mb-4">
            {t("drawer_openedAt")}: {new Date(session.opened_at).toLocaleString()} · {session.opened_by}
          </p>

          {byMethod.length > 0 && (
            <>
              <h3 className="font-semibold mb-2">{t("drawer_byMethod")}</h3>
              <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
                <table className="w-full text-sm min-w-[520px]">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2">{t("pos_paymentMethod")}</th>
                      <th className="text-left px-3 py-2">{t("history_totalOrders")}</th>
                      <th className="text-left px-3 py-2">{t("history_totalSale")}</th>
                      <th className="text-left px-3 py-2">{t("history_totalRefund")}</th>
                      <th className="text-left px-3 py-2">{t("history_netSale")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byMethod.map((m) => (
                      <tr key={m.method} className={`border-t border-slate-100 ${m.method === "cash" ? "bg-blue-50/40" : ""}`}>
                        <td className="px-3 py-2 font-medium uppercase">
                          {m.method}
                          {m.method === "cash" && (
                            <span className="ml-1 text-[10px] text-blue-600">({t("drawer_inTill")})</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{m.orders}</td>
                        <td className="px-3 py-2">{fmt(m.sales)}</td>
                        <td className="px-3 py-2 text-red-600">{m.refunds ? `-${fmt(m.refunds)}` : "-"}</td>
                        <td className="px-3 py-2 font-medium">{fmt(m.sales - m.refunds)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-slate-300 font-bold">
                      <td className="px-3 py-2">{t("pos_total")}</td>
                      <td className="px-3 py-2">{byMethod.reduce((s, m) => s + m.orders, 0)}</td>
                      <td className="px-3 py-2">{fmt(byMethod.reduce((s, m) => s + m.sales, 0))}</td>
                      <td className="px-3 py-2 text-red-600">
                        -{fmt(byMethod.reduce((s, m) => s + m.refunds, 0))}
                      </td>
                      <td className="px-3 py-2">
                        {fmt(byMethod.reduce((s, m) => s + m.sales - m.refunds, 0))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}

          {movements.length > 0 && (
            <>
              <h3 className="font-semibold mb-2">{t("drawer_movements")}</h3>
              <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
                <table className="w-full text-sm min-w-[560px]">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2">{t("history_time")}</th>
                      <th className="text-left px-3 py-2">{t("ledger_type")}</th>
                      <th className="text-left px-3 py-2">{t("settle_amount")}</th>
                      <th className="text-left px-3 py-2">{t("transferIn_note")}</th>
                      <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((m) => (
                      <tr key={m.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{new Date(m.created_at).toLocaleString()}</td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            m.direction === "in" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}>
                            {t(m.direction === "in" ? "drawer_in" : "drawer_out")}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {m.direction === "in" ? "+" : "-"}{fmt(Number(m.amount))}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{m.reason}</td>
                        <td className="px-3 py-2 text-slate-400 text-xs">{m.created_by || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {!loading && history.length > 0 && (
        <>
          <h3 className="font-semibold mb-2">{t("drawer_history")}</h3>
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("drawer_closedAt")}</th>
                  <th className="text-left px-3 py-2">{t("drawer_opening")}</th>
                  <th className="text-left px-3 py-2">{t("drawer_expected")}</th>
                  <th className="text-left px-3 py-2">{t("drawer_counted")}</th>
                  <th className="text-left px-3 py-2">{t("drawer_variance")}</th>
                  <th className="text-left px-3 py-2">{t("po_receivedBy")}</th>
                  <th className="text-left px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const v = Number(h.variance || 0);
                  return (
                    <tr key={h.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        {h.closed_at ? new Date(h.closed_at).toLocaleString() : "-"}
                      </td>
                      <td className="px-3 py-2">{fmt(Number(h.opening_amount))}</td>
                      <td className="px-3 py-2">{fmt(Number(h.expected_amount || 0))}</td>
                      <td className="px-3 py-2 font-medium">{fmt(Number(h.counted_amount || 0))}</td>
                      <td className={`px-3 py-2 font-bold ${
                        Math.abs(v) < 0.5 ? "text-slate-400" : v > 0 ? "text-blue-600" : "text-red-600"
                      }`}>
                        {v > 0 ? "+" : ""}{fmt(v)}
                        {h.note && <div className="text-[10px] font-normal text-slate-500">{h.note}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-400 text-xs">{h.closed_by || "-"}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => printZReport(h)} className="text-blue-600 text-xs font-medium">
                          {t("drawer_printZ")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Z-Report: printed on the same roll as receipts, so a shift can be filed */}
      {zReport && (
        <div id="receipt-print" className="hidden print:block">
          <div style={{ textAlign: "center", marginBottom: "6px" }}>
            <strong>{storeName}</strong>
            <div>{t("drawer_zReport")}</div>
          </div>
          <div>{t("drawer_openedAt")}: {new Date(zReport.opened_at).toLocaleString()}</div>
          <div>{zReport.opened_by}</div>
          {zReport.closed_at && (
            <>
              <div>{t("drawer_closedAt")}: {new Date(zReport.closed_at).toLocaleString()}</div>
              <div>{zReport.closed_by}</div>
            </>
          )}
          <div>--------------------------------</div>
          {byMethod.map((m) => (
            <div key={m.method} style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{m.method.toUpperCase()} ({m.orders})</span>
              <span>{fmt(m.sales - m.refunds)}</span>
            </div>
          ))}
          <div>--------------------------------</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{t("drawer_opening")}</span><span>{fmt(Number(zReport.opening_amount))}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{t("drawer_cashSales")}</span><span>+{fmt(cashSales)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{t("drawer_cashRefunds")}</span><span>-{fmt(cashRefunds)}</span>
          </div>
          {movedIn > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{t("drawer_in")}</span><span>+{fmt(movedIn)}</span>
            </div>
          )}
          {movedOut > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{t("drawer_out")}</span><span>-{fmt(movedOut)}</span>
            </div>
          )}
          <div>--------------------------------</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{t("drawer_expected")}</strong>
            <strong>{fmt(Number(zReport.expected_amount ?? expected))}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{t("drawer_counted")}</strong>
            <strong>{fmt(Number(zReport.counted_amount ?? 0))}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{t("drawer_variance")}</strong>
            <strong>{fmt(Number(zReport.variance ?? 0))}</strong>
          </div>
          {zReport.note && <div style={{ marginTop: "4px" }}>{zReport.note}</div>}
          <div style={{ textAlign: "center", marginTop: "8px" }}>
            ______________________<br />
            {t("po_approvedBy")}
          </div>
        </div>
      )}

      {showOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("drawer_open")}</h3>
            <p className="text-sm text-slate-500 mb-4">{t("drawer_openHint")}</p>
            <label className="text-sm text-slate-600">{t("drawer_opening")}</label>
            <input type="number" autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={openingAmount} onChange={(e) => setOpeningAmount(e.target.value)} />
            <div className="flex gap-2">
              <button onClick={() => setShowOpen(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={openDrawer} disabled={saving}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("drawer_open")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showMove && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-4">{t("drawer_addMovement")}</h3>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <button onClick={() => setMoveDir("out")}
                className={`py-2 rounded-lg text-sm font-medium border ${
                  moveDir === "out" ? "bg-red-600 text-white border-red-600" : "border-slate-200"
                }`}>
                {t("drawer_out")}
              </button>
              <button onClick={() => setMoveDir("in")}
                className={`py-2 rounded-lg text-sm font-medium border ${
                  moveDir === "in" ? "bg-green-600 text-white border-green-600" : "border-slate-200"
                }`}>
                {t("drawer_in")}
              </button>
            </div>

            <label className="text-sm text-slate-600">{t("settle_amount")}</label>
            <input type="number" autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} />

            <label className="text-sm text-slate-600">{t("transferIn_note")} *</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              placeholder={t("drawer_reasonPlaceholder")}
              value={moveReason} onChange={(e) => setMoveReason(e.target.value)} />

            <div className="flex gap-2">
              <button onClick={() => setShowMove(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={addMovement} disabled={saving}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("products_save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showClose && session && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-4">{t("drawer_close")}</h3>

            <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs text-slate-600 mb-4 space-y-1">
              <div className="flex justify-between">
                <span>{t("drawer_opening")}</span><span>{fmt(Number(session.opening_amount))}</span>
              </div>
              <div className="flex justify-between text-green-700">
                <span>{t("drawer_cashSales")}</span><span>+{fmt(cashSales)}</span>
              </div>
              <div className="flex justify-between text-red-600">
                <span>{t("drawer_cashRefunds")}</span><span>-{fmt(cashRefunds)}</span>
              </div>
              {movedIn > 0 && (
                <div className="flex justify-between text-green-700">
                  <span>{t("drawer_in")}</span><span>+{fmt(movedIn)}</span>
                </div>
              )}
              {movedOut > 0 && (
                <div className="flex justify-between text-red-600">
                  <span>{t("drawer_out")}</span><span>-{fmt(movedOut)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-slate-900 border-t border-slate-200 pt-1">
                <span>{t("drawer_expected")}</span><span>{fmt(expected)}</span>
              </div>
            </div>

            {byMethod.filter((m) => m.method !== "cash").length > 0 && (
              <div className="border border-slate-200 rounded-lg px-3 py-2 text-xs mb-4">
                <div className="text-slate-400 uppercase text-[10px] mb-1">{t("drawer_nonCashNote")}</div>
                {byMethod
                  .filter((m) => m.method !== "cash")
                  .map((m) => (
                    <div key={m.method} className="flex justify-between text-slate-600">
                      <span className="uppercase">{m.method}</span>
                      <span>{fmt(m.sales - m.refunds)}</span>
                    </div>
                  ))}
              </div>
            )}

            <label className="text-sm text-slate-600">{t("drawer_counted")} *</label>
            <input type="number" autoFocus
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={countedAmount} onChange={(e) => setCountedAmount(e.target.value)} />

            {countedAmount.trim() !== "" && (
              <div className={`rounded-lg px-3 py-2 text-sm mb-3 ${
                Math.abs(variance) < 0.5
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : variance < 0
                  ? "bg-red-50 text-red-700 border border-red-200"
                  : "bg-blue-50 text-blue-700 border border-blue-200"
              }`}>
                {Math.abs(variance) < 0.5
                  ? `✅ ${t("drawer_balanced")}`
                  : `${variance < 0 ? "⚠️ " + t("drawer_short") : "ℹ️ " + t("drawer_over")}: ${fmt(Math.abs(variance))}`}
              </div>
            )}

            {Math.abs(variance) > 0.5 && countedAmount.trim() !== "" && (
              <>
                <label className="text-sm text-slate-600">
                  {t("transferIn_note")} <span className="text-red-600">*</span>
                </label>
                <textarea rows={2}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
                  placeholder={t("drawer_variancePlaceholder")}
                  value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
              </>
            )}

            <div className="flex gap-2">
              <button onClick={() => setShowClose(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={closeDrawer} disabled={saving}
                className="flex-1 py-2.5 bg-red-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("drawer_close")}
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
