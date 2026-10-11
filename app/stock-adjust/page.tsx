"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type Hit = {
  key: string; product_id: string; variant_id: string | null;
  display_name: string; sku: string | null; stock_qty: number;
};

type Past = {
  id: string; product_id: string; before_qty: number; after_qty: number;
  reason: string; note: string | null; created_at: string;
};

const REASONS = [
  "Count correction",
  "Found extra",
  "Damage found",
  "Theft or loss",
  "Data entry error",
  "Removing test data",
];

export default function StockAdjustPage() {
  const { storeId, stores, isStoreLocked } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [locId, setLocId] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [newQty, setNewQty] = useState("");
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<Past[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (profile && !hasPermission(profile, "stock-adjust")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => { if (!locId && storeId) setLocId(storeId); }, [storeId, locId]);
  useEffect(() => { if (locId) loadPast(); /* eslint-disable-next-line */ }, [locId]);

  async function loadPast() {
    const { data } = await supabase.from("stock_adjustments")
      .select("id, product_id, before_qty, after_qty, reason, note, created_at")
      .eq("store_id", locId).order("created_at", { ascending: false }).limit(30);
    const rows = (data as Past[]) || [];
    setPast(rows);
    const ids = [...new Set(rows.map((r) => r.product_id))];
    if (ids.length) {
      const { data: ps } = await supabase.from("products").select("id, name").in("id", ids);
      const m: Record<string, string> = {};
      for (const p of (ps as { id: string; name: string }[]) || []) m[p.id] = p.name;
      setNames(m);
    }
  }

  async function search(text: string) {
    setQ(text); setPicked(null);
    if (text.trim().length < 2 || !locId) { setHits([]); return; }
    const { data } = await supabase
      .rpc("sellable_items", { p_store: locId, p_include_inactive: false })
      .ilike("display_name", `%${text.trim()}%`)
      .order("display_name").limit(20);
    setHits(((data as any[]) || []).map((r) => ({
      key: r.key, product_id: r.product_id, variant_id: r.variant_id,
      display_name: r.display_name, sku: r.sku, stock_qty: Number(r.stock_qty || 0),
    })));
  }

  async function apply() {
    if (!picked) return;
    const target = Number(newQty);
    if (!Number.isFinite(target) || target < 0) return setMsg("Enter a quantity");
    if (target === picked.stock_qty) return setMsg("That is the quantity already on record");
    const delta = target - picked.stock_qty;
    if (!confirm(
      `${picked.display_name}\n${picked.stock_qty} -> ${target}  (${delta > 0 ? "+" : ""}${delta})\n\nReason: ${reason}\n\nApply this change?`
    )) return;
    setBusy(true);
    const { error } = await supabase.rpc("adjust_stock", {
      p_store: locId, p_product: picked.product_id, p_variant: picked.variant_id,
      p_new_qty: target, p_reason: reason, p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) return setMsg(error.message);
    setMsg(`${picked.display_name}: ${picked.stock_qty} -> ${target}`);
    setPicked(null); setHits([]); setQ(""); setNewQty(""); setNote("");
    loadPast();
  }

  if (!profile || !hasPermission(profile, "stock-adjust")) return null;

  return (
    <div className="max-w-3xl mx-auto pt-4">
      <h2 className="font-semibold text-lg mb-1">{t("nav_stockAdjust")}</h2>
      <p className="text-sm text-slate-500 mb-4">
        Correct what the system holds to match what was counted. Every change is recorded
        with who made it and why.
      </p>

      {!isStoreLocked && (
        <select className={"border rounded-lg px-3 py-2 text-sm mb-4 " + (locId ? "border-slate-200" : "border-blue-500 ring-2 ring-blue-100")}
          value={locId} onChange={(e) => { setLocId(e.target.value); setPicked(null); setHits([]); setQ(""); }}>
          {!locId && <option value="">{t("store_choose")}</option>}
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.is_warehouse ? `🏭 ${s.name}` : s.name}</option>
          ))}
        </select>
      )}

      {locId && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 mb-5">
          <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            placeholder="Search product by name" value={q} onChange={(e) => search(e.target.value)} />

          {hits.length > 0 && !picked && (
            <div className="mt-3 border border-slate-100 rounded-lg divide-y divide-slate-100 max-h-72 overflow-auto">
              {hits.map((h) => (
                <button key={h.key} onClick={() => { setPicked(h); setNewQty(String(h.stock_qty)); setHits([]); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex justify-between gap-3">
                  <span>{h.display_name}<span className="text-slate-400 text-xs ml-2">{h.sku}</span></span>
                  <span className="text-slate-500 shrink-0">{h.stock_qty.toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}

          {picked && (
            <div className="mt-4 space-y-3">
              <div className="text-sm">
                <div className="font-medium">{picked.display_name}</div>
                <div className="text-slate-500 text-xs">
                  {picked.sku} · on record now: <strong>{picked.stock_qty.toLocaleString()}</strong>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <label className="text-sm">
                  <div className="text-slate-500 text-xs mb-1">Counted quantity</div>
                  <input type="number" min={0} className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-40"
                    value={newQty} onChange={(e) => setNewQty(e.target.value)} />
                </label>
                <label className="text-sm">
                  <div className="text-slate-500 text-xs mb-1">Reason</div>
                  <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    value={reason} onChange={(e) => setReason(e.target.value)}>
                    {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
              </div>

              <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />

              <div className="flex gap-2">
                <button onClick={() => setPicked(null)}
                  className="px-3 py-2 border border-slate-200 rounded-lg text-sm">Cancel</button>
                <button onClick={apply} disabled={busy}
                  className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-40">
                  {busy ? "Saving…" : "Apply"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {msg && <div className="mb-4 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-700">{msg}</div>}

      {past.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs min-w-[620px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {["When", "Product", "From", "To", "Reason", "Note"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-500">{r.created_at.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-3 py-1.5">{names[r.product_id] || "-"}</td>
                  <td className="px-3 py-1.5 text-right">{Number(r.before_qty).toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{Number(r.after_qty).toLocaleString()}</td>
                  <td className="px-3 py-1.5">{r.reason}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.note || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
