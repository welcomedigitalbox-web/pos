"use client";

import { useEffect, useState } from "react";
import { supabase, SellableItem, CENTRAL_WAREHOUSE_ID, fetchSellableItems } from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";

type LedgerRow = {
  date: string;
  type: "in" | "out";
  qty: number;
  reference: string;
};

export default function LedgerPage() {
  const { stores } = useStore();
  const [storeId, setStoreId] = useState(CENTRAL_WAREHOUSE_ID);
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [items, setItems] = useState<SellableItem[]>([]);
  const [itemKey, setItemKey] = useState("");
  const [rows, setRows] = useState<(LedgerRow & { balance: number })[]>([]);

  useEffect(() => {
    if (profile && !hasPermission(profile, "ledger")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (itemKey) loadLedger();
    else setRows([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, storeId]);

  if (!profile || !hasPermission(profile, "ledger")) return null;

  async function loadItems() {
    const data = await fetchSellableItems(storeId);
    setItems(data);
  }

  async function loadLedger() {
    const item = items.find((i) => i.key === itemKey);
    if (!item) return;

    let purchaseQuery = supabase
      .from("stock_purchases")
      .select("qty, created_at, supplier")
      .eq("product_id", item.product_id)
      .eq("store_id", storeId);
    purchaseQuery = item.variant_id
      ? purchaseQuery.eq("variant_id", item.variant_id)
      : purchaseQuery.is("variant_id", null);
    const { data: purchases } = await purchaseQuery.order("created_at", { ascending: true });

    let saleQuery = supabase
      .from("sale_items")
      .select("qty, created_at, sale_id, sales!inner(store_id)")
      .eq("product_id", item.product_id)
      .eq("sales.store_id", storeId);
    saleQuery = item.variant_id
      ? saleQuery.eq("variant_id", item.variant_id)
      : saleQuery.is("variant_id", null);
    const { data: items_ } = await saleQuery.order("created_at", { ascending: true });

    // Transfers OUT of the central warehouse / INTO a store
    let transferOutQuery = supabase
      .from("stock_transfers")
      .select("qty, created_at, to_store_id")
      .eq("product_id", item.product_id);
    transferOutQuery = item.variant_id
      ? transferOutQuery.eq("variant_id", item.variant_id)
      : transferOutQuery.is("variant_id", null);
    const { data: transfers } = await transferOutQuery.order("created_at", { ascending: true });

    const isWarehouse = storeId === CENTRAL_WAREHOUSE_ID;
    const transferRows: LedgerRow[] = (transfers || [])
      .filter((tr) => (isWarehouse ? true : tr.to_store_id === storeId))
      .map((tr) => ({
        date: tr.created_at,
        type: isWarehouse ? ("out" as const) : ("in" as const),
        qty: Number(tr.qty),
        reference: isWarehouse ? `Transfer → ${tr.to_store_id}` : "Transfer in",
      }));

    // Damages recorded at this location
    let damageQuery = supabase
      .from("stock_damages")
      .select("qty, created_at, reason")
      .eq("product_id", item.product_id)
      .eq("store_id", storeId);
    damageQuery = item.variant_id
      ? damageQuery.eq("variant_id", item.variant_id)
      : damageQuery.is("variant_id", null);
    const { data: damages } = await damageQuery.order("created_at", { ascending: true });

    const combined: LedgerRow[] = [
      ...transferRows,
      ...(damages || []).map((d) => ({
        date: d.created_at,
        type: "out" as const,
        qty: Number(d.qty),
        reference: d.reason ? `Damage (${d.reason})` : "Damage",
      })),
      ...(purchases || []).map((p) => ({
        date: p.created_at,
        type: "in" as const,
        qty: Number(p.qty),
        reference: p.supplier ? `Stock-in (${p.supplier})` : "Stock-in",
      })),
      ...(items_ || []).map((i) => ({
        date: i.created_at,
        type: "out" as const,
        qty: Number(i.qty),
        reference: `Sale #${i.sale_id.slice(0, 8).toUpperCase()}`,
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let balance = 0;
    const withBalance = combined.map((r) => {
      balance += r.type === "in" ? r.qty : -r.qty;
      return { ...r, balance };
    });
    setRows(withBalance.reverse());
  }

  return (
    <div className="pt-4">
      <h2 className="font-semibold text-lg mb-3">{t("ledger_title")}</h2>

      <select
        className="w-full sm:w-64 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
        value={storeId}
        onChange={(e) => {
          setStoreId(e.target.value);
          setItemKey("");
        }}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.is_warehouse ? `🏭 ${s.name}` : s.name}
          </option>
        ))}
      </select>

      <select
        className="w-full sm:w-80 border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        value={itemKey}
        onChange={(e) => setItemKey(e.target.value)}
      >
        <option value="">{t("ledger_selectProduct")}</option>
        {items.map((i) => (
          <option key={i.key} value={i.key}>
            {i.display_name}
          </option>
        ))}
      </select>

      {itemKey && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[500px]">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t("ledger_date")}</th>
                <th className="text-left px-3 py-2">{t("ledger_type")}</th>
                <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                <th className="text-left px-3 py-2">{t("ledger_balance")}</th>
                <th className="text-left px-3 py-2">{t("ledger_reference")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-2">{new Date(r.date).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        r.type === "in" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {r.type === "in" ? t("ledger_in") : t("ledger_out")}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.type === "in" ? "+" : "-"}
                    {r.qty}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.balance}</td>
                  <td className="px-3 py-2 text-slate-400">{r.reference}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-8">
                    {t("ledger_empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
