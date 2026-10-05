"use client";

// =====================================================================
// One page for everything waiting on a manager's signature.
//
// Until now an approval was found by remembering which screen it lived
// on: purchase orders here, consignment orders there, returns somewhere
// else again. A manager who did not already know where to look saw
// nothing at all, and work sat still because of it.
//
// This page asks the database what this particular person may approve —
// department by department, through can_approve_dept — and then shows
// only what is actually waiting. Someone who approves nothing sees an
// empty page, which is the honest answer rather than a locked door.
//
// Purchase orders are approved here, because that is one call and the
// page already knows who is asking. Everything else links to the screen
// that does the job properly, since approving a return or a discrepancy
// means looking at the goods first.
// =====================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

type Dept = "merchandising" | "sale" | "warehouse";

type Item = {
  id: string;
  ref: string;
  who: string;
  when: string;
  detail: string;
  amount?: number;
};

type Group = {
  key: string;
  dept: Dept;
  icon: string;
  title: { my: string; en: string };
  // Where the work is actually done, for everything this page does not
  // settle itself.
  href: string;
  items: Item[];
  // Only purchase orders are approved from here.
  approve?: (item: Item) => Promise<void>;
};

const L = {
  title: { my: "ခွင့်ပြုရန် စာရင်း", en: "Waiting for approval" },
  subtitle: {
    my: "မင်း ခွင့်ပြုပေးရမယ့် အလုပ်တွေ အကုန် ဒီမှာ",
    en: "Everything that needs your sign-off, in one place",
  },
  empty: {
    my: "ခွင့်ပြုရန် မရှိပါ — အကုန် ရှင်းပြီးပါပြီ",
    en: "Nothing is waiting. All clear.",
  },
  nothingToApprove: {
    my: "မင်းက ခွင့်ပြုပေးရမယ့် တာဝန် မရှိပါ",
    en: "You are not an approver for any department",
  },
  loading: { my: "ဖွင့်နေသည်...", en: "Loading..." },
  approve: { my: "ခွင့်ပြုမည်", en: "Approve" },
  open: { my: "ဖွင့်ကြည့်", en: "Open" },
  openAll: { my: "အကုန်ကြည့်", en: "See all" },
  refresh: { my: "ပြန်ဖွင့်", en: "Refresh" },
  by: { my: "တင်သူ", en: "Raised by" },
  more: { my: "အခြား", en: "more" },
  g_po: { my: "ဝယ်ယူမှု အော်ဒါ (အတည်ပြုရန်)", en: "Purchase orders" },
  g_copo: { my: "အပ်နှံပစ္စည်း အော်ဒါ", en: "Consignment orders" },
  g_ret: { my: "ပြန်အပ် (Return)", en: "Sale returns" },
  g_req: { my: "ပစ္စည်း တောင်းဆိုမှု", en: "Stock requests" },
  g_dmg: { my: "ပျက်စီး စာရင်း", en: "Damage write-offs" },
  g_trf: { my: "ပစ္စည်း ပို့မှု", en: "Stock transfers" },
};

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function day(ts?: string | null) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Yangon" });
}

export default function ApprovalsPage() {
  const { profile } = useAuth();
  const { lang } = useLanguage();
  const router = useRouter();

  const [depts, setDepts] = useState<Dept[]>([]);
  const [checked, setChecked] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const say = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(""), 3500);
  };
  const txt = (p: { my: string; en: string }) => (lang === "my" ? p.my : p.en);

  useEffect(() => {
    if (profile && !hasPermission(profile, "approvals")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // What this person may approve is the database's answer, not the
  // browser's guess: the same function the approving RPCs themselves
  // call, so the page can never offer a button the server would refuse.
  useEffect(() => {
    if (!profile) return;
    let live = true;
    (async () => {
      const all: Dept[] = ["merchandising", "sale", "warehouse"];
      const results = await Promise.all(
        all.map((d) =>
          supabase
            .rpc("can_approve_dept", { p_department: d })
            .then(({ data }) => (data ? d : null))
        )
      );
      if (!live) return;
      setDepts(results.filter(Boolean) as Dept[]);
      setChecked(true);
    })();
    return () => {
      live = false;
    };
  }, [profile?.id]);

  const load = useCallback(async () => {
    if (!checked) return;
    setLoading(true);
    const may = (d: Dept) => depts.includes(d);
    const out: Group[] = [];

    try {
      // Everything is asked for at once; a manager opening this page is
      // waiting on the slowest query, not the sum of them.
      const { data: signDamage } = await supabase.rpc("can_approve_damage");
      const canSignDamage = !!signDamage;

      const [pos, returns, requests, damages, transfers] = await Promise.all([
        may("merchandising")
          ? supabase
              .from("purchase_orders")
              .select(
                "id, po_number, order_date, is_consignment, created_by, suppliers(name), purchase_order_items(qty, unit_cost)"
              )
              .eq("status", "draft")
              .order("order_date", { ascending: true })
              .limit(200)
          : Promise.resolve({ data: [], error: null }),

        may("sale")
          ? supabase
              .from("sale_returns")
              .select("id, return_number, store_id, refund_amount, reason, requested_by, created_at")
              .eq("status", "pending")
              .order("created_at", { ascending: true })
              .limit(200)
          : Promise.resolve({ data: [], error: null }),

        may("warehouse")
          ? supabase
              .from("stock_requests")
              .select("id, request_no, store_id, requested_qty, requested_by, created_at")
              .eq("status", "pending")
              .order("created_at", { ascending: true })
              .limit(500)
          : Promise.resolve({ data: [], error: null }),

        canSignDamage
          ? supabase
              .from("stock_damages")
              .select("id, damage_no, store_id, qty, reason, reported_by, created_at")
              .eq("status", "pending")
              .order("created_at", { ascending: true })
              .limit(200)
          : Promise.resolve({ data: [], error: null }),

        may("warehouse")
          ? supabase
              .from("stock_transfers")
              .select(
                "id, transfer_no, from_store_id, to_store_id, qty, status, discrepancy_note, transferred_by, created_at"
              )
              .in("status", ["pending_approval", "discrepancy"])
              .order("created_at", { ascending: true })
              .limit(200)
          : Promise.resolve({ data: [], error: null }),
      ]);

      const poRows = (pos.data || []) as any[];
      const poItem = (po: any): Item => ({
        id: po.id,
        ref: po.po_number,
        who: po.created_by || "-",
        when: po.order_date || "",
        detail: po.suppliers?.name || "-",
        amount: (po.purchase_order_items || []).reduce(
          (s: number, i: any) => s + Number(i.qty || 0) * Number(i.unit_cost || 0),
          0
        ),
      });

      const approvePo = async (item: Item) => {
        setBusy(item.id);
        try {
          const { error } = await supabase.rpc("approve_po", { p_po: item.id });
          if (error) throw error;
          say("✅ " + item.ref);
          await load();
        } catch (err) {
          say("❌ " + describeError(err));
        } finally {
          setBusy(null);
        }
      };

      const normalPo = poRows.filter((p) => !p.is_consignment).map(poItem);
      if (normalPo.length)
        out.push({
          key: "po",
          dept: "merchandising",
          icon: "🧾",
          title: L.g_po,
          href: "/purchase-orders",
          items: normalPo,
          approve: approvePo,
        });

      const consignPo = poRows.filter((p) => p.is_consignment).map(poItem);
      if (consignPo.length)
        out.push({
          key: "copo",
          dept: "merchandising",
          icon: "🤝",
          title: L.g_copo,
          href: "/consignment",
          items: consignPo,
          approve: approvePo,
        });

      const retRows = (returns.data || []) as any[];
      if (retRows.length)
        out.push({
          key: "returns",
          dept: "sale",
          icon: "↩️",
          title: L.g_ret,
          href: "/returns",
          items: retRows.map((r) => ({
            id: r.id,
            ref: r.return_number || r.id.slice(0, 8),
            who: r.requested_by || "-",
            when: day(r.created_at),
            detail: [r.store_id, r.reason].filter(Boolean).join(" · "),
            amount: Number(r.refund_amount || 0),
          })),
        });

      // Stock requests are filed one line per product but answered by the
      // number the shop asked under, so they are counted that way here.
      const reqRows = (requests.data || []) as any[];
      const byNo = new Map<string, any[]>();
      for (const r of reqRows) {
        const k = r.request_no || r.id;
        byNo.set(k, [...(byNo.get(k) || []), r]);
      }
      if (byNo.size)
        out.push({
          key: "requests",
          dept: "warehouse",
          icon: "📦",
          title: L.g_req,
          href: "/request-inbox",
          items: [...byNo.entries()].map(([no, lines]) => ({
            id: no,
            ref: no,
            who: lines[0].requested_by || "-",
            when: day(lines[0].created_at),
            detail: `${lines[0].store_id} · ${lines.length} ${lang === "my" ? "မျိုး" : "lines"}`,
          })),
        });

      const dmgRows = (damages.data || []) as any[];
      if (dmgRows.length)
        out.push({
          key: "damage",
          dept: "warehouse",
          icon: "⚠️",
          title: L.g_dmg,
          href: "/damage",
          items: dmgRows.map((d) => ({
            id: d.id,
            ref: d.damage_no || d.id.slice(0, 8),
            who: d.reported_by || "-",
            when: day(d.created_at),
            detail: [d.store_id, `${d.qty}`, d.reason].filter(Boolean).join(" · "),
          })),
        });

      const trfRows = (transfers.data || []) as any[];
      if (trfRows.length)
        out.push({
          key: "transfers",
          dept: "warehouse",
          icon: "🚚",
          title: L.g_trf,
          href: "/stock-transfer",
          items: trfRows.map((r) => ({
            id: r.id,
            ref: r.transfer_no || r.id.slice(0, 8),
            who: r.transferred_by || "-",
            when: day(r.created_at),
            detail: [`${r.from_store_id} → ${r.to_store_id}`, r.status, r.discrepancy_note]
              .filter(Boolean)
              .join(" · "),
          })),
        });

      setGroups(out);
    } catch (err) {
      say("❌ " + describeError(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, depts.join(","), lang]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const total = useMemo(
    () => groups.reduce((s, g) => s + g.items.length, 0),
    [groups]
  );

  if (!profile || !hasPermission(profile, "approvals")) return null;

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            {txt(L.title)}
            {total > 0 && (
              <span className="bg-red-600 text-white text-sm rounded-full px-2.5 py-0.5">
                {total}
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">{txt(L.subtitle)}</p>
        </div>
        <button
          onClick={() => load()}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-600"
        >
          {txt(L.refresh)}
        </button>
      </div>

      {loading && <div className="text-sm text-slate-400">{txt(L.loading)}</div>}

      {!loading && checked && depts.length === 0 && (
        <div className="border border-slate-200 rounded-xl p-6 text-center text-slate-500">
          {txt(L.nothingToApprove)}
        </div>
      )}

      {!loading && depts.length > 0 && total === 0 && (
        <div className="border border-green-200 bg-green-50 rounded-xl p-6 text-center text-green-700">
          ✅ {txt(L.empty)}
        </div>
      )}

      <div className="space-y-4">
        {groups.map((g) => {
          const show = expanded[g.key] ? g.items : g.items.slice(0, 5);
          const hidden = g.items.length - show.length;
          return (
            <section key={g.key} className="border border-slate-200 rounded-xl overflow-hidden">
              <header className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                <h2 className="font-medium text-sm flex items-center gap-2">
                  <span>{g.icon}</span>
                  {txt(g.title)}
                  <span className="bg-amber-100 text-amber-800 text-xs rounded-full px-2 py-0.5">
                    {g.items.length}
                  </span>
                </h2>
                <Link href={g.href} className="text-xs text-blue-600">
                  {txt(L.openAll)} →
                </Link>
              </header>

              <div className="divide-y divide-slate-100">
                {show.map((it) => (
                  <div
                    key={it.id}
                    className="px-4 py-2.5 flex items-center gap-3 flex-wrap sm:flex-nowrap"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{it.ref}</div>
                      <div className="text-xs text-slate-500 truncate">
                        {it.detail}
                        {it.who && it.who !== "-" ? ` · ${txt(L.by)}: ${it.who}` : ""}
                      </div>
                    </div>
                    {it.amount != null && it.amount > 0 && (
                      <div className="text-sm tabular-nums">{fmt(it.amount)}</div>
                    )}
                    <div className="text-xs text-slate-400 w-20 shrink-0">{it.when}</div>
                    <div className="flex gap-1.5 shrink-0">
                      {g.approve && (
                        <button
                          disabled={busy === it.id}
                          onClick={() => g.approve!(it)}
                          className="text-xs bg-blue-600 text-white rounded-lg px-3 py-1.5 disabled:opacity-50"
                        >
                          {busy === it.id ? "..." : txt(L.approve)}
                        </button>
                      )}
                      <Link
                        href={
                          g.key === "po" || g.key === "copo"
                            ? `/purchase-orders/${it.id}`
                            : g.href
                        }
                        className="text-xs border border-slate-200 rounded-lg px-3 py-1.5 text-slate-600"
                      >
                        {txt(L.open)}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>

              {hidden > 0 && (
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [g.key]: true }))}
                  className="w-full px-4 py-2 text-xs text-blue-600 bg-slate-50 border-t border-slate-100"
                >
                  + {hidden} {txt(L.more)}
                </button>
              )}
            </section>
          );
        })}
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm rounded-lg px-4 py-2 shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
