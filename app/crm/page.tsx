"use client";

// The loyalty desk: one customer at a time. Everything the shop can do to a
// card happens here, and every change goes through a database function so the
// rules of the scheme are the same from the till, this page and the customer's
// own card.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";

type Found = { id: string; name: string; phone: string | null; card_token: string | null };

type Card = {
  name: string;
  phone: string | null;
  member_since: string | null;
  tier: string | null;
  discount_percent: number | null;
  stickers_available: number;
  stickers_to_reward: number;
  spend_per_sticker: number;
  points_available: number;
  points_to_reward: number;
  referrals_made: number;
  purchases: { date: string; store: string; amount: number; ref: string | null }[];
};

const CARD_SITE = "https://customer.edubabyhouse.store/c/";

function money(n: number) {
  return new Intl.NumberFormat("en-US").format(Math.round(n)) + " Ks";
}

export default function CrmPage() {
  const { profile } = useAuth();
  const { storeId } = useStore();
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [amount, setAmount] = useState("");
  const [saleRef, setSaleRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "customers")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  function say(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  const loadCard = useCallback(async (c: Found) => {
    const { data, error } = await supabase.rpc("crm_card", { p_token: c.card_token });
    if (error) return say("❌ " + error.message);
    setCard(data as Card);
  }, []);

  async function find() {
    const q = search.trim();
    if (!q) return;
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, phone, card_token")
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(20);
    if (error) return say("❌ " + error.message);
    const rows = (data as Found[]) || [];
    setResults(rows);
    if (rows.length === 1) {
      setPicked(rows[0]);
      loadCard(rows[0]);
    }
  }

  async function recordSpend() {
    if (!picked) return;
    const n = Number(amount);
    if (!n || n <= 0) return say("Enter the bill amount");
    setBusy(true);
    const { error } = await supabase.rpc("crm_record_spend", {
      p_customer_id: picked.id,
      p_amount: n,
      p_sale_ref: saleRef || null,
      p_store_id: storeId || null,
    });
    setBusy(false);
    if (error) return say("❌ " + error.message);
    setAmount("");
    setSaleRef("");
    say("Saved");
    loadCard(picked);
  }

  async function redeem(kind: "stickers" | "points") {
    if (!picked) return;
    setBusy(true);
    const { error } = await supabase.rpc(
      kind === "stickers" ? "crm_redeem_stickers" : "crm_redeem_points",
      { p_customer_id: picked.id, p_sale_ref: saleRef || null }
    );
    setBusy(false);
    if (error) return say("❌ " + error.message);
    say(kind === "stickers" ? "10% discount unlocked" : "5,000 Ks discount unlocked");
    loadCard(picked);
  }

  if (!profile || !hasPermission(profile, "customers")) return null;

  const link = picked?.card_token ? CARD_SITE + picked.card_token : "";

  return (
    <div className="p-3 sm:p-4 max-w-4xl">
      <h1 className="text-xl font-semibold mb-3">Loyalty</h1>

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
          placeholder="Name or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && find()}
        />
        <button onClick={find} className="bg-slate-900 text-white rounded-lg px-4 text-sm font-medium">
          Find
        </button>
      </div>

      {results.length > 1 && !picked && (
        <div className="border border-slate-200 rounded-xl divide-y mb-4">
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => { setPicked(r); loadCard(r); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
            >
              {r.name} <span className="text-slate-400">· {r.phone || "no phone"}</span>
            </button>
          ))}
        </div>
      )}

      {picked && card && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">{card.name}</div>
                <div className="text-sm text-slate-500">
                  {card.phone || "no phone"}
                  {card.member_since && ` · member since ${card.member_since}`}
                </div>
              </div>
              <button
                onClick={() => { setPicked(null); setCard(null); setResults([]); }}
                className="text-xs text-slate-400"
              >
                change
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-xs text-slate-500">Member card</div>
                <div className="font-semibold">
                  {card.tier ? `${card.tier} · ${card.discount_percent}%` : "—"}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-xs text-slate-500">Stickers</div>
                <div className="font-semibold">
                  {card.stickers_available} / 10
                </div>
                <div className="text-[11px] text-slate-400">
                  one per {money(card.spend_per_sticker)} bill
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-xs text-slate-500">Mom Love points</div>
                <div className="font-semibold">{card.points_available} / 5</div>
                <div className="text-[11px] text-slate-400">
                  {card.referrals_made} referred
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mt-3">
              <button
                disabled={busy || card.stickers_available < 10}
                onClick={() => redeem("stickers")}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white disabled:bg-slate-200 disabled:text-slate-400"
              >
                Use 10 stickers → 10% off
              </button>
              <button
                disabled={busy || card.points_available < 5}
                onClick={() => redeem("points")}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white disabled:bg-slate-200 disabled:text-slate-400"
              >
                Use 5 points → 5,000 Ks off
              </button>
            </div>

            {/* Only one discount may be given on a bill, so the cashier is told
                rather than left to work it out. */}
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3">
              Only one discount per bill: member card, stickers, points or a promotion.
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-sm font-medium mb-2">Record a purchase</div>
            <div className="flex flex-wrap gap-2">
              <input
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-40"
                placeholder="Bill amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <input
                className="border border-slate-200 rounded-lg px-3 py-2 text-sm w-48"
                placeholder="Invoice no. (optional)"
                value={saleRef}
                onChange={(e) => setSaleRef(e.target.value)}
              />
              <button
                disabled={busy}
                onClick={recordSpend}
                className="bg-slate-900 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:bg-slate-300"
              >
                Save
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              Until the POS is in daily use, enter the bill here so the sticker is counted.
            </p>
          </div>

          {link && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-sm font-medium mb-2">Digital card</div>
              <div className="flex flex-wrap items-center gap-3">
                {/* Drawn by a public QR service, so nothing extra ships in the bundle. */}
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(link)}`}
                  alt="card QR"
                  width={160}
                  height={160}
                  className="rounded-lg border border-slate-200"
                />
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-slate-500 break-all">{link}</div>
                  <button
                    onClick={() => { navigator.clipboard.writeText(link); say("Link copied"); }}
                    className="mt-2 text-xs border border-slate-200 rounded-lg px-3 py-1.5"
                  >
                    Copy link
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="text-sm font-medium px-4 pt-4">Purchases</div>
            <table className="w-full text-sm mt-2">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Date</th>
                  <th className="text-left px-4 py-2">Store</th>
                  <th className="text-left px-4 py-2">Invoice</th>
                  <th className="text-right px-4 py-2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {card.purchases.map((p, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-4 py-2 whitespace-nowrap">{p.date}</td>
                    <td className="px-4 py-2">{p.store}</td>
                    <td className="px-4 py-2 font-mono text-xs">{p.ref || "-"}</td>
                    <td className="px-4 py-2 text-right">{money(p.amount)}</td>
                  </tr>
                ))}
                {card.purchases.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-slate-400 py-6">
                      Nothing recorded yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
