"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { hasPermission } from "../permissions";
import { useRouter } from "next/navigation";

function fmt(n: number) {
  return Math.round(Number(n) || 0).toLocaleString() + " MMK";
}

// A package is an ordinary product with its own barcode and price that holds
// no stock of its own. Selling one takes its parts out of stock instead, so
// what can be sold is however many the parts on the shelf can make up.
type Prod = {
  id: string;
  name: string;
  sku: string | null;
  price: number | null;
  is_package: boolean | null;
};

type Comp = {
  id: string;
  component_product_id: string;
  component_variant_id: string | null;
  qty: number;
  name: string;
  sku: string | null;
  price: number;
};

export default function PackagesPage() {
  const { profile } = useAuth();
  const router = useRouter();

  const [products, setProducts] = useState<Prod[]>([]);
  const [packages, setPackages] = useState<Prod[]>([]);
  const [pkgId, setPkgId] = useState("");
  const [comps, setComps] = useState<Comp[]>([]);
  const [pick, setPick] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (profile && !hasPermission(profile, "products")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    loadProducts();
  }, []);

  useEffect(() => {
    if (pkgId) loadComps(pkgId);
    else setComps([]);
  }, [pkgId]);

  if (!profile || !hasPermission(profile, "products")) return null;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  }

  async function loadProducts() {
    const { data } = await supabase
      .from("products")
      .select("id,name,sku,price,is_package")
      .eq("is_active", true)
      .order("name")
      .limit(2000);
    const list = (data as Prod[]) || [];
    setProducts(list);
    setPackages(list.filter((p) => p.is_package));
  }

  async function loadComps(id: string) {
    const { data } = await supabase
      .from("product_packages")
      .select("id,component_product_id,component_variant_id,qty")
      .eq("package_product_id", id);
    const rows = (data as Omit<Comp, "name" | "sku" | "price">[]) || [];
    setComps(
      rows.map((r) => {
        const p = products.find((x) => x.id === r.component_product_id);
        return {
          ...r,
          name: p?.name || r.component_product_id,
          sku: p?.sku || null,
          price: Number(p?.price) || 0,
        };
      })
    );
  }

  async function addComp() {
    if (!pkgId) return showToast("Pick the package first");
    if (!pick) return showToast("Pick what goes in it");
    const n = Number(qty);
    if (!(n > 0)) return showToast("Quantity has to be above zero");
    setBusy(true);
    try {
      const { error } = await supabase.from("product_packages").insert({
        package_product_id: pkgId,
        component_product_id: pick,
        qty: n,
      });
      if (error) throw error;
      setPick("");
      setQty("1");
      await loadProducts();
      await loadComps(pkgId);
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function removeComp(id: string) {
    const { error } = await supabase.from("product_packages").delete().eq("id", id);
    if (error) return showToast("❌ " + error.message);
    await loadComps(pkgId);
  }

  const pkg = products.find((p) => p.id === pkgId);
  const partsWorth = comps.reduce((s, c) => s + c.qty * c.price, 0);
  const pkgPrice = Number(pkg?.price) || 0;
  const saving = partsWorth - pkgPrice;

  // Only products that are not packages themselves can go inside one.
  const choosable = products.filter(
    (p) => !p.is_package && p.id !== pkgId && !comps.some((c) => c.component_product_id === p.id)
  );

  return (
    <div className="pt-4 max-w-3xl">
      <h2 className="font-semibold text-lg mb-1">Packages</h2>
      <p className="text-sm text-slate-500 mb-4">
        Several items sold as one scan. Create the package in Products first
        with its own barcode and price, then say here what goes in it. The
        package keeps no stock of its own &mdash; selling one takes its parts out
        of stock.
      </p>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
        <label className="text-sm text-slate-600">Package</label>
        <select
          className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
          value={pkgId}
          onChange={(e) => setPkgId(e.target.value)}
        >
          <option value="">-</option>
          {packages.length > 0 && (
            <optgroup label="Packages">
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.sku ? `(${p.sku})` : ""}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Turn a product into a package">
            {products
              .filter((p) => !p.is_package)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.sku ? `(${p.sku})` : ""}
                </option>
              ))}
          </optgroup>
        </select>
      </div>

      {pkgId && (
        <>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">What goes in</th>
                  <th className="text-left px-3 py-2">Barcode</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">On its own</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {comps.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{c.sku || "-"}</td>
                    <td className="px-3 py-2 text-right">{c.qty}</td>
                    <td className="px-3 py-2 text-right text-slate-500">
                      {fmt(c.qty * c.price)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => removeComp(c.id)}
                        className="text-red-600 text-xs font-medium"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {comps.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-400 py-6">
                      Nothing in it yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
            <label className="text-sm text-slate-600">Add an item</label>
            <div className="flex gap-2 mt-1">
              <select
                className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">-</option>
                {choosable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.sku ? `(${p.sku})` : ""} &mdash; {fmt(Number(p.price) || 0)}
                  </option>
                ))}
              </select>
              <input
                type="number"
                className="w-20 border border-slate-200 rounded-lg px-2 py-2 text-sm text-right"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
              <button
                onClick={addComp}
                disabled={busy}
                className="px-4 py-2 bg-slate-900 disabled:bg-slate-300 text-white rounded-lg text-sm font-medium"
              >
                Add
              </button>
            </div>
          </div>

          {comps.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm space-y-1">
              <div className="flex justify-between text-slate-500">
                <span>Parts bought separately</span>
                <span>{fmt(partsWorth)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Package price</span>
                <span>{fmt(pkgPrice)}</span>
              </div>
              <div
                className={`flex justify-between font-medium ${
                  saving > 0 ? "text-green-700" : saving < 0 ? "text-red-600" : "text-slate-400"
                }`}
              >
                <span>{saving >= 0 ? "Customer saves" : "Package costs MORE than the parts"}</span>
                <span>{fmt(Math.abs(saving))}</span>
              </div>
              {pkgPrice <= 0 && (
                <div className="text-xs text-red-600 pt-1">
                  This package has no price. Set one in Products or it cannot be sold.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50 max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
