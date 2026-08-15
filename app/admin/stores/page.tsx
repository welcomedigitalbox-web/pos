"use client";

import { useEffect, useState } from "react";
import { supabase, StoreRow, logActivity } from "@/lib/supabase";
import { useStore } from "../../store-context";
import { useAuth } from "../../auth-context";
import { useLanguage } from "../../language-context";

export default function AdminStoresPage() {
  const { refreshStores } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();

  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [isWarehouse, setIsWarehouse] = useState(false);
  const [saving, setSaving] = useState(false);

  const [mergeSource, setMergeSource] = useState<StoreRow | null>(null);
  const [supplyWh, setSupplyWh] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!profile || profile.role !== "admin") return null;

  async function load() {
    setLoading(true);
    const { data } = await supabase.from("stores").select("*").order("name");
    setStores((data as StoreRow[]) || []);
    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { error } = await supabase.from("stores").insert({
        id: id.trim().toUpperCase(),
        name: name.trim(),
        region: region.trim() || null,
        is_warehouse: isWarehouse,
        supply_warehouse_id: isWarehouse ? null : supplyWh || null,
      });
      if (error) throw error;
      showToast(t("admin_storeCreated"));
      setShowForm(false);
      setId(""); setName(""); setRegion(""); setIsWarehouse(false);
      await load();
      await refreshStores();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s: StoreRow) {
    if (s.is_active && !confirm(t("admin_storeArchiveConfirm"))) return;
    const { error } = await supabase.from("stores").update({ is_active: !s.is_active }).eq("id", s.id);
    if (error) return showToast("❌ " + error.message);
    await logActivity({
      entityType: "store",
      entityId: null,
      action: s.is_active ? "archived" : "restored",
      detail: `${s.name} (${s.id})`,
      actor: profile?.email,
    });
    showToast(s.is_active ? t("admin_storeArchived") : t("admin_storeRestored"));
    await load();
    await refreshStores();
  }

  async function submitMerge() {
    if (!mergeSource || !mergeTarget) return;
    if (!confirm(t("admin_mergeConfirm"))) return;

    setMerging(true);
    try {
      const { error } = await supabase.rpc("merge_store", {
        source_id: mergeSource.id,
        target_id: mergeTarget,
      });
      if (error) throw error;
      await logActivity({
        entityType: "store",
        entityId: null,
        action: "merged",
        detail: `${mergeSource.id} → ${mergeTarget}`,
        actor: profile?.email,
      });
      showToast(t("admin_mergeSuccess"));
      setMergeSource(null);
      await load();
      await refreshStores();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setMerging(false);
    }
  }

  // Merging a shop into a warehouse (or vice versa) would corrupt the stock model,
  // so only same-type locations can be combined.
  const mergeTargets = stores.filter(
    (s) => s.is_active && s.id !== mergeSource?.id && s.is_warehouse === mergeSource?.is_warehouse
  );

  async function setSupplyWarehouse(storeId: string, warehouseId: string) {
    const { error } = await supabase
      .from("stores")
      .update({ supply_warehouse_id: warehouseId || null })
      .eq("id", storeId);
    if (error) return showToast("❌ " + error.message);
    showToast(t("admin_supplyWarehouseSaved"));
    await load();
    await refreshStores();
  }

  function openNew(asWarehouse: boolean) {
    setId("");
    setName("");
    setRegion("");
    setIsWarehouse(asWarehouse);
    setSupplyWh("");
    setShowForm(true);
  }

  const retailList = stores.filter((s) => !s.is_warehouse);
  const warehouseList = stores.filter((s) => s.is_warehouse);

  const renderTable = (list: StoreRow[], isWh: boolean) => (
    <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-6">
      <table className="w-full text-sm min-w-[680px]">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="text-left px-4 py-2">ID</th>
            <th className="text-left px-4 py-2">{t("customers_name")}</th>
            <th className="text-left px-4 py-2">{t("admin_storeRegion")}</th>
            {!isWh && <th className="text-left px-4 py-2">{t("admin_supplyWarehouse")}</th>}
            <th className="text-left px-4 py-2">{t("admin_active")}</th>
            <th className="text-left px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={6} className="text-center text-slate-400 py-8">...</td></tr>}
          {!loading && list.map((s) => (
            <tr key={s.id} className={`border-t border-slate-100 ${!s.is_active ? "opacity-50 bg-slate-50" : ""}`}>
              <td className="px-4 py-2 font-mono text-xs">{s.id}</td>
              <td className="px-4 py-2 font-medium">{isWh && "🏭 "}{s.name}</td>
              <td className="px-4 py-2 text-slate-500">{s.region || "-"}</td>
              {!isWh && (
                <td className="px-4 py-2">
                  <select
                    className="border border-slate-200 rounded px-2 py-1 text-xs"
                    value={s.supply_warehouse_id || ""}
                    onChange={(e) => setSupplyWarehouse(s.id, e.target.value)}
                  >
                    <option value="">{t("admin_supplyWarehouseNone")}</option>
                    {stores.filter((w) => w.is_warehouse && w.is_active).map((w) => (
                      <option key={w.id} value={w.id}>🏭 {w.name}</option>
                    ))}
                  </select>
                </td>
              )}
              <td className="px-4 py-2">{s.is_active ? "🟢" : "⚪"}</td>
              <td className="px-4 py-2 text-right space-x-3">
                {s.is_active && (
                  <button onClick={() => { setMergeSource(s); setMergeTarget(""); }}
                    className="text-blue-600 text-xs font-medium">
                    {t("admin_storeMerge")}
                  </button>
                )}
                <button onClick={() => toggleActive(s)}
                  className={`text-xs font-medium ${s.is_active ? "text-red-600" : "text-green-600"}`}>
                  {s.is_active ? t("admin_storeArchive") : t("products_restore")}
                </button>
              </td>
            </tr>
          ))}
          {!loading && list.length === 0 && (
            <tr><td colSpan={6} className="text-center text-slate-400 py-8">-</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">🏬 {t("admin_storesSection")}</h2>
        <button onClick={() => openNew(false)} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("admin_storeAddNew")}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-3">{t("admin_storesSectionNote")}</p>
      {renderTable(retailList, false)}

      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">🏭 {t("admin_warehousesSection")}</h2>
        <button onClick={() => openNew(true)} className="bg-slate-700 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("admin_warehouseAddNew")}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-3">{t("admin_warehousesSectionNote")}</p>
      {renderTable(warehouseList, true)}


      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleCreate} className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">
              {isWarehouse ? t("admin_warehouseAddNew") : t("admin_storeAddNew")}
            </h3>
            <p className={`text-xs mb-4 px-2 py-1 rounded inline-block ${
              isWarehouse ? "bg-slate-100 text-slate-600" : "bg-blue-50 text-blue-700"
            }`}>
              {isWarehouse ? `🏭 ${t("admin_storeWarehouse")}` : `🏬 ${t("admin_storeRetail")}`}
            </p>

            <label className="text-sm text-slate-600">{t("admin_storeId")}</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1 font-mono"
              value={id} onChange={(e) => setId(e.target.value)} placeholder={isWarehouse ? "MDY-WH" : "MDY-SHOWROOM"} required />
            <p className="text-xs text-slate-400 mb-3">{t("admin_storeIdHint")}</p>

            <label className="text-sm text-slate-600">{t("customers_name")}</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={name} onChange={(e) => setName(e.target.value)} placeholder={isWarehouse ? "Mandalay Warehouse" : "Mandalay Showroom"} required />

            <label className="text-sm text-slate-600">{t("admin_storeRegion")}</label>
            <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1"
              value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Mandalay" />
            <p className="text-xs text-slate-400 mb-3">{t("admin_storeRegionHint")}</p>


            {!isWarehouse && (
              <>
                <label className="text-sm text-slate-600">{t("admin_supplyWarehouse")}</label>
                <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-1"
                  value={supplyWh} onChange={(e) => setSupplyWh(e.target.value)}>
                  <option value="">{t("admin_supplyWarehouseNone")}</option>
                  {stores.filter((w) => w.is_warehouse && w.is_active).map((w) => (
                    <option key={w.id} value={w.id}>🏭 {w.name}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 mb-4">{t("admin_supplyWarehouseHint")}</p>
              </>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("products_save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {mergeSource && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-lg">
            <h3 className="font-semibold text-lg mb-1">{t("admin_storeMerge")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              <span className="font-medium">{mergeSource.name}</span> → ?
            </p>

            <label className="text-sm text-slate-600">{t("admin_mergeTarget")}</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3"
              value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
              <option value="">{t("stockIn_selectPlaceholder")}</option>
              {mergeTargets.map((s) => (
                <option key={s.id} value={s.id}>{s.is_warehouse ? `🏭 ${s.name}` : s.name}</option>
              ))}
            </select>

            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 mb-4">
              {t("admin_mergeWarning")}
            </div>

            <div className="flex gap-2">
              <button onClick={() => setMergeSource(null)}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitMerge} disabled={merging || !mergeTarget}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {merging ? "..." : t("admin_storeMerge")}
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
