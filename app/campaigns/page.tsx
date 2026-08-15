"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase, AdCampaign, AdPlatform } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type Row = AdCampaign & {
  spend: number;
  clicks: number;
  impressions: number;
  // Sales during the campaign window, and the same span immediately before it
  salesDuring: number;
  ordersDuring: number;
  salesBefore: number;
  couponSales: number;
  couponOrders: number;
};

const platformLabel: Record<string, string> = {
  meta: "📘 Facebook / IG",
  tiktok: "🎵 TikTok",
  other: "🔗 Other",
};

export default function CampaignsPage() {
  const { stores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<AdPlatform>("meta");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budget, setBudget] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [storeId, setStoreId] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "campaigns")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || !hasPermission(profile, "campaigns")) return null;

  async function load() {
    setLoading(true);

    const { data: campaigns } = await supabase
      .from("ad_campaigns")
      .select("*")
      .order("start_date", { ascending: false });

    const { data: stats } = await supabase.from("ad_daily_stats").select("*");

    const built: Row[] = [];
    for (const c of (campaigns as AdCampaign[]) || []) {
      const own = ((stats as any[]) || []).filter((s) => s.campaign_id === c.id);

      const start = new Date(c.start_date);
      const end = c.end_date ? new Date(c.end_date) : new Date();
      const endInclusive = new Date(end.getTime() + 86400000 - 1);
      const days = Math.max(1, Math.ceil((endInclusive.getTime() - start.getTime()) / 86400000));

      // Compare against the same number of days immediately before the campaign,
      // which is the closest thing to a baseline without a proper control group
      const beforeStart = new Date(start.getTime() - days * 86400000);

      let duringQuery = supabase
        .from("sales")
        .select("total")
        .gte("created_at", start.toISOString())
        .lte("created_at", endInclusive.toISOString());
      let beforeQuery = supabase
        .from("sales")
        .select("total")
        .gte("created_at", beforeStart.toISOString())
        .lt("created_at", start.toISOString());
      if (c.store_id) {
        duringQuery = duringQuery.eq("store_id", c.store_id);
        beforeQuery = beforeQuery.eq("store_id", c.store_id);
      }

      const [{ data: during }, { data: before }] = await Promise.all([duringQuery, beforeQuery]);

      // A coupon is the only hard link between an ad and a sale, so count it separately
      let couponSales = 0;
      let couponOrders = 0;
      if (c.coupon_code) {
        const { data: cs } = await supabase
          .from("sales")
          .select("total")
          .ilike("note", `%${c.coupon_code}%`)
          .gte("created_at", start.toISOString())
          .lte("created_at", endInclusive.toISOString());
        couponOrders = (cs || []).length;
        couponSales = (cs || []).reduce((sum, s: any) => sum + Number(s.total), 0);
      }

      built.push({
        ...c,
        spend: own.reduce((s, x) => s + Number(x.spend), 0),
        clicks: own.reduce((s, x) => s + Number(x.clicks), 0),
        impressions: own.reduce((s, x) => s + Number(x.impressions), 0),
        salesDuring: (during || []).reduce((s, x: any) => s + Number(x.total), 0),
        ordersDuring: (during || []).length,
        salesBefore: (before || []).reduce((s, x: any) => s + Number(x.total), 0),
        couponSales,
        couponOrders,
      });
    }

    setRows(built);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  function openNew() {
    setEditingId(null);
    setPlatform("meta");
    setName("");
    setStartDate("");
    setEndDate("");
    setBudget("");
    setCouponCode("");
    setStoreId("");
    setNote("");
    setShowForm(true);
  }

  function openEdit(c: Row) {
    setEditingId(c.id);
    setPlatform(c.platform);
    setName(c.name);
    setStartDate(c.start_date);
    setEndDate(c.end_date || "");
    setBudget(String(c.budget));
    setCouponCode(c.coupon_code || "");
    setStoreId(c.store_id || "");
    setNote(c.note || "");
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !startDate) return;
    const payload = {
      platform,
      name: name.trim(),
      start_date: startDate,
      end_date: endDate || null,
      budget: Number(budget) || 0,
      coupon_code: couponCode.trim() || null,
      store_id: storeId || null,
      note: note.trim() || null,
      created_by: profile?.email || null,
    };
    const { data: saved, error } = editingId
      ? await supabase.from("ad_campaigns").update(payload).eq("id", editingId).select().single()
      : await supabase.from("ad_campaigns").insert(payload).select().single();
    if (error) return showToast("❌ " + error.message);

    // With no API yet, spread the budget evenly so spend-per-day is still usable
    if (!editingId && Number(budget) > 0 && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
      const perDay = Number(budget) / days;
      const stats = Array.from({ length: days }, (_, i) => {
        const d = new Date(start.getTime() + i * 86400000);
        return {
          campaign_id: saved.id,
          stat_date: d.toISOString().slice(0, 10),
          spend: perDay,
        };
      });
      await supabase.from("ad_daily_stats").upsert(stats, { onConflict: "campaign_id,stat_date" });
    }

    showToast(t("campaigns_saved"));
    setShowForm(false);
    await load();
  }

  async function handleDelete(id: string) {
    if (!confirm(t("productCategory_deleteConfirm"))) return;
    await supabase.from("ad_campaigns").delete().eq("id", id);
    await load();
  }

  const totals = useMemo(
    () => ({
      campaigns: rows.length,
      spend: rows.reduce((s, r) => s + r.spend, 0),
      salesDuring: rows.reduce((s, r) => s + r.salesDuring, 0),
      couponSales: rows.reduce((s, r) => s + r.couponSales, 0),
    }),
    [rows]
  );

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_campaigns")}</h2>
        <button onClick={openNew} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("campaigns_new")}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">{t("campaigns_subtitle")}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("campaigns_count")}</div>
          <div className="text-xl font-bold mt-1">{totals.campaigns}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("campaigns_spend")}</div>
          <div className="text-lg font-bold mt-1 text-orange-600">{fmt(totals.spend)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("campaigns_salesDuring")}</div>
          <div className="text-lg font-bold mt-1">{fmt(totals.salesDuring)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-xs text-slate-500 uppercase">{t("campaigns_couponSales")}</div>
          <div className="text-lg font-bold mt-1 text-green-700">{fmt(totals.couponSales)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("campaigns_name")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_platform")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_period")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_spend")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_salesDuring")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_vsBefore")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_coupon")}</th>
              <th className="text-left px-3 py-2">{t("campaigns_roas")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && rows.map((r) => {
              const lift = r.salesBefore > 0 ? ((r.salesDuring - r.salesBefore) / r.salesBefore) * 100 : null;
              const roas = r.spend > 0 ? r.salesDuring / r.spend : null;
              return (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    {r.name}
                    {r.store_id && <div className="text-[10px] text-slate-400">{r.store_id}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{platformLabel[r.platform]}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {r.start_date}
                    {r.end_date && ` → ${r.end_date}`}
                  </td>
                  <td className="px-3 py-2 text-orange-600 font-medium">{fmt(r.spend)}</td>
                  <td className="px-3 py-2 font-medium">
                    {fmt(r.salesDuring)}
                    <div className="text-[10px] text-slate-400">{r.ordersDuring} {t("history_totalOrders")}</div>
                  </td>
                  <td className="px-3 py-2">
                    {lift === null ? (
                      <span className="text-slate-300">-</span>
                    ) : (
                      <span className={lift >= 0 ? "text-green-700 font-medium" : "text-red-600 font-medium"}>
                        {lift >= 0 ? "+" : ""}{lift.toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.coupon_code ? (
                      <>
                        <span className="font-mono text-xs">{r.coupon_code}</span>
                        <div className="text-[10px] text-green-700">
                          {r.couponOrders} · {fmt(r.couponSales)}
                        </div>
                      </>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    {roas === null ? <span className="text-slate-300">-</span> : `${roas.toFixed(1)}x`}
                  </td>
                  <td className="px-3 py-2 text-right space-x-2">
                    <button onClick={() => openEdit(r)} className="text-blue-600 text-xs font-medium">
                      {t("products_edit")}
                    </button>
                    <button onClick={() => handleDelete(r.id)} className="text-red-600 text-xs font-medium">
                      {t("products_delete")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-400 mt-3">{t("campaigns_liftHint")}</p>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={handleSave} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-4">
              {editingId ? t("products_edit") : t("campaigns_new")}
            </h3>

            <label className="text-sm text-slate-600">{t("campaigns_platform")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={platform} onChange={(e) => setPlatform(e.target.value as AdPlatform)}>
              <option value="meta">📘 Facebook / Instagram</option>
              <option value="tiktok">🎵 TikTok</option>
              <option value="other">🔗 {t("saleOrder_channelOther")}</option>
            </select>

            <label className="text-sm text-slate-600">{t("campaigns_name")} *</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="August Diaper Promo" />

            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="text-sm text-slate-600">{t("ledger_periodCustom")} *</label>
                <input type="date" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              </div>
              <div>
                <label className="text-sm text-slate-600">&nbsp;</label>
                <input type="date" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                  value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>

            <label className="text-sm text-slate-600">{t("campaigns_budget")}</label>
            <input type="number" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1"
              value={budget} onChange={(e) => setBudget(e.target.value)} />
            <p className="text-xs text-slate-400 mb-3">{t("campaigns_budgetHint")}</p>

            <label className="text-sm text-slate-600">{t("campaigns_coupon")}</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1"
              value={couponCode} onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              placeholder="FB0815" />
            <p className="text-xs text-slate-400 mb-3">{t("campaigns_couponHint")}</p>

            <label className="text-sm text-slate-600">{t("admin_store")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              <option value="">{t("warehouse_allStores")}</option>
              {stores.filter((s) => !s.is_warehouse).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            <label className="text-sm text-slate-600">{t("pos_note")}</label>
            <textarea rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-4"
              value={note} onChange={(e) => setNote(e.target.value)} />

            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button type="submit" className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold">
                {t("products_save")}
              </button>
            </div>
          </form>
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
