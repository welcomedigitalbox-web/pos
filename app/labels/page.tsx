"use client";

// =====================================================================
// Sticker labels for the warehouse.
//
// The department already has a label and a printer: a Nippon POS RP400H
// on 115mm paper, three 40×25mm labels across. So this page does not
// invent a format — it reproduces the one on the roll, and prints through
// the printer's own Windows driver like any other document.
//
// What goes on a label is what somebody standing at a shelf needs: the
// product's name, a barcode a scanner will actually read, and the code
// underneath in case the scanner will not.
//
// Quantities come from the goods that arrived, not from a person counting
// again: pick a received purchase order and the lines come with their
// quantities already set.
// =====================================================================

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, fetchSellableItems, SellableItem, describeError } from "@/lib/supabase";
import { useAuth } from "../auth-context";
import { useStore } from "../store-context";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";
import { code128Svg, moduleWidthMm } from "@/lib/code128";

type Line = {
  key: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  sku: string | null;
  price: number;
  code: string;          // what the barcode will carry
  codeKind: string;      // where that code came from
  qty: number;
};

// The roll the department buys today, as far as a photograph shows: three
// labels across 115mm of backing paper, which puts each one near 38mm.
// "Near" is not good enough for a printer, so the numbers are editable and
// what is set is remembered. Measure the roll once, type it in once.
const DEFAULT_SIZE = { w: 38, h: 25, across: 3 };
const SIZE_KEY = "edu.labelSize";

export default function LabelsPage() {
  const { profile } = useAuth();
  const { storeId } = useStore();
  const { t } = useLanguage();
  const router = useRouter();

  const [items, setItems] = useState<SellableItem[]>([]);
  // Every code a product answers to, so the person printing can say which
  // one goes on the sticker — the warehouse's and the showroom's are not
  // always the same code.
  const [barcodes, setBarcodes] = useState<Record<string, { barcode: string; kind: string }[]>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState("");
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [showPrice, setShowPrice] = useState(false);
  const [showName, setShowName] = useState(true);
  const [pos, setPos] = useState<{ id: string; po_number: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SIZE_KEY);
      if (saved) setSize({ ...DEFAULT_SIZE, ...JSON.parse(saved) });
    } catch {
      // A browser that will not keep it is not a reason to stop working.
    }
  }, []);

  function setDim(k: "w" | "h" | "across", v: number) {
    const next = { ...size, [k]: v };
    setSize(next);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(next)); } catch {}
  }

  useEffect(() => {
    if (profile && !hasPermission(profile, "labels")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    if (!storeId) return;
    (async () => {
      const [list, bc, po] = await Promise.all([
        fetchSellableItems(storeId, true),
        supabase.from("product_barcodes")
          .select("product_id,variant_id,barcode,kind")
          .eq("is_active", true)
          .neq("kind", "carton")
          .limit(5000),
        supabase.from("purchase_orders")
          .select("id,po_number,status,order_date")
          .in("status", ["received", "partial"])
          .order("order_date", { ascending: false })
          .limit(30),
      ]);
      setItems(list);
      const map: Record<string, { barcode: string; kind: string }[]> = {};
      for (const b of (bc.data as any[]) || []) {
        const k = `${b.product_id}:${b.variant_id || "base"}`;
        (map[k] ||= []).push({ barcode: b.barcode, kind: b.kind });
      }
      setBarcodes(map);
      setPos(((po.data as any[]) || []).map((p) => ({ id: p.id, po_number: p.po_number })));
    })();
  }, [storeId]);

  function say(m: string) {
    setToast(m);
    setTimeout(() => setToast(""), 3500);
  }

  // Every code this product answers to, best first. The one we printed is
  // offered ahead of the supplier's, because a warehouse sticker is the
  // reason somebody is on this page.
  function codesFor(product_id: string, variant_id: string | null, sku?: string | null) {
    const list = [...(barcodes[`${product_id}:${variant_id || "base"}`] || [])];
    list.sort((a, b) => {
      const rank = (k: string) => (k === "internal" ? 0 : k === "supplier" ? 1 : 2);
      return rank(a.kind) - rank(b.kind);
    });
    if (sku && !list.some((c) => c.barcode === sku)) {
      list.push({ barcode: sku, kind: "sku" });
    }
    return list;
  }

  function codeFor(i: SellableItem) {
    const list = codesFor(i.product_id, i.variant_id, i.sku);
    return list.length ? { code: list[0].barcode, kind: list[0].kind } : { code: "", kind: "none" };
  }

  // A code typed in here is a code the system will answer to afterwards.
  // Printing one it does not know would make a sticker that scans as
  // nothing, which is worse than no sticker.
  async function saveCode(line: Line, raw: string) {
    const code = raw.trim();
    if (!code) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("product_barcodes").insert({
        product_id: line.product_id,
        variant_id: line.variant_id,
        barcode: code,
        // Ours starts with EDU; anything else came off a box.
        kind: /^EDU\d/i.test(code) ? "internal" : "supplier",
        created_by: profile?.email || null,
      });
      if (error) throw error;

      const k = `${line.product_id}:${line.variant_id || "base"}`;
      const kind = /^EDU\d/i.test(code) ? "internal" : "supplier";
      setBarcodes((m) => ({ ...m, [k]: [...(m[k] || []), { barcode: code, kind }] }));
      setLines((rows) => rows.map((r) =>
        r.key === line.key ? { ...r, code, codeKind: kind } : r));
      setAdding(null);
      setNewCode("");
    } catch (err) {
      say("❌ " + describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function addItem(i: SellableItem, qty = 1) {
    const c = codeFor(i);
    setLines((rows) => {
      const at = rows.findIndex((r) => r.key === i.key);
      if (at >= 0) {
        return rows.map((r, n) => (n === at ? { ...r, qty: r.qty + qty } : r));
      }
      return [...rows, {
        key: i.key, product_id: i.product_id, variant_id: i.variant_id,
        name: i.display_name, sku: i.sku, price: i.price,
        code: c.code, codeKind: c.kind, qty,
      }];
    });
  }

  // Goods that have arrived are the usual reason to print: the quantities
  // are already known, so they are not asked for again.
  async function fromPo(poId: string) {
    if (!poId) return;
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("purchase_order_items")
        .select("product_id, variant_id, received_qty")
        .eq("po_id", poId)
        .gt("received_qty", 0);
      if (error) throw error;
      let added = 0;
      for (const row of (data as any[]) || []) {
        const hit = items.find(
          (i) => i.product_id === row.product_id &&
            (i.variant_id || null) === (row.variant_id || null)
        );
        if (hit) { addItem(hit, Number(row.received_qty) || 0); added++; }
      }
      say(added ? `✅ ${added}` : "❌ " + t("warehouse_empty"));
    } catch (err) {
      say("❌ " + describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // Goods with no barcode of their own get one of ours, once.
  async function issueCode(line: Line) {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("issue_internal_barcode", {
        p_product: line.product_id,
        p_variant: line.variant_id,
      });
      if (error) throw error;
      const code = String(data);
      setLines((rows) => rows.map((r) =>
        r.key === line.key ? { ...r, code, codeKind: "internal" } : r));
      const k = `${line.product_id}:${line.variant_id || "base"}`;
      setBarcodes((m) => ({
        ...m,
        [k]: [...(m[k] || []).filter((c) => c.barcode !== code), { barcode: code, kind: "internal" }],
      }));
    } catch (err) {
      say("❌ " + describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const found = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return items.filter(
      (i) => i.display_name.toLowerCase().includes(q) || (i.sku || "").toLowerCase().includes(q)
    ).slice(0, 20);
  }, [items, search]);

  // One entry per sticker, which is what the sheet is laid out from.
  const stickers = useMemo(
    () => lines.flatMap((l) => Array.from({ length: Math.max(0, Math.floor(l.qty)) }, () => l)),
    [lines]
  );

  const total = stickers.length;
  const barcodeWidth = size.w - 6;
  const tooNarrow = lines.filter(
    (l) => l.code && moduleWidthMm(l.code, barcodeWidth) < 0.25
  );
  const noCode = lines.filter((l) => !l.code);

  if (!profile || !hasPermission(profile, "labels")) return null;

  return (
    <div className="p-4 sm:p-6 max-w-5xl print:p-0">
      <style>{`
        @media print {
          /* The roll, not a page of A4. Margins are the printer's job. */
          @page { size: ${size.across * size.w}mm ${size.h}mm; margin: 0; }
          body * { visibility: hidden; }
          #sheet, #sheet * { visibility: visible; }
          #sheet { position: absolute; left: 0; top: 0; }
          /* Hidden is not gone: the shell still took up height, so the
             printer was handed three blank labels after the real one. */
          html, body { height: 0 !important; overflow: hidden !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print">
        <h1 className="text-xl font-semibold">{t("labels_title")}</h1>
        <p className="text-sm text-slate-500 mt-0.5 mb-4">{t("labels_subtitle")}</p>

        <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-slate-500">{t("labels_w")}</label>
              <input type="number" step="0.5" value={size.w}
                onChange={(e) => setDim("w", Number(e.target.value))}
                className="block w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1" />
            </div>
            <div>
              <label className="text-xs text-slate-500">{t("labels_h")}</label>
              <input type="number" step="0.5" value={size.h}
                onChange={(e) => setDim("h", Number(e.target.value))}
                className="block w-20 border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1" />
            </div>
            <div>
              <label className="text-xs text-slate-500">{t("labels_across")}</label>
              <input type="number" min={1} max={6} value={size.across}
                onChange={(e) => setDim("across", Number(e.target.value))}
                className="block w-16 border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1" />
            </div>
            <div className="text-xs text-slate-500 pb-2">
              {t("labels_rollWidth")}: <strong>{(size.w * size.across).toFixed(1)}mm</strong>
              <span className="block text-slate-400">{t("labels_rollHint")}</span>
            </div>
            <div>
              <label className="text-xs text-slate-500">{t("labels_fromPo")}</label>
              <select defaultValue="" disabled={busy}
                onChange={(e) => { fromPo(e.target.value); e.target.value = ""; }}
                className="block border border-slate-200 rounded-lg px-2 py-1.5 text-sm mt-1 max-w-[170px]">
                <option value="">{t("stockIn_selectPlaceholder")}</option>
                {pos.map((p) => <option key={p.id} value={p.id}>{p.po_number}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-sm pb-2">
              <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} />
              {t("labels_showName")}
            </label>
            <label className="flex items-center gap-1.5 text-sm pb-2">
              <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />
              {t("labels_showPrice")}
            </label>
          </div>

          <div className="mt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("labels_search")}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
            {found.length > 0 && (
              <div className="border border-slate-200 rounded-lg mt-1 divide-y divide-slate-100 max-h-56 overflow-y-auto">
                {found.map((i) => (
                  <button key={i.key} onClick={() => { addItem(i); setSearch(""); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50">
                    {i.display_name}
                    <span className="text-slate-400 ml-2">{i.sku}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {lines.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                  <th className="text-left px-3 py-2">{t("labels_code")}</th>
                  <th className="text-right px-3 py-2">{t("labels_qty")}</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-slate-100">
                    <td className="px-3 py-2">{l.name}</td>
                    <td className="px-3 py-2">
                      {adding === l.key ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            autoFocus
                            value={newCode}
                            onChange={(e) => setNewCode(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveCode(l, newCode); }}
                            placeholder={t("labels_newCode")}
                            className="border border-slate-200 rounded px-2 py-1 text-sm font-mono w-40"
                          />
                          <button onClick={() => saveCode(l, newCode)} disabled={busy}
                            className="text-xs text-blue-600">{t("labels_save")}</button>
                          <button onClick={() => { setAdding(null); setNewCode(""); }}
                            className="text-xs text-slate-400">✕</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          {(() => {
                            const list = codesFor(l.product_id, l.variant_id, l.sku);
                            if (!list.length) {
                              return (
                                <button onClick={() => issueCode(l)} disabled={busy}
                                  className="text-xs text-blue-600 underline">
                                  {t("labels_issue")}
                                </button>
                              );
                            }
                            return (
                              <select
                                value={l.code}
                                onChange={(e) => {
                                  const pick = list.find((c) => c.barcode === e.target.value);
                                  setLines((rows) => rows.map((r) => r.key === l.key
                                    ? { ...r, code: e.target.value, codeKind: pick?.kind || "sku" }
                                    : r));
                                }}
                                className="border border-slate-200 rounded px-2 py-1 text-sm font-mono">
                                {list.map((c) => (
                                  <option key={c.barcode} value={c.barcode}>
                                    {c.barcode} · {t(`labels_kind_${c.kind}` as never)}
                                  </option>
                                ))}
                              </select>
                            );
                          })()}
                          <button onClick={() => { setAdding(l.key); setNewCode(""); }}
                            className="text-xs text-blue-600">+ {t("labels_addCode")}</button>
                          {/* Goods that arrived with a barcode do not need
                              one of ours, and a second code on the same
                              product is a second answer to the same scan.
                              So this is offered only when there is nothing
                              to scan yet. */}
                          {!codesFor(l.product_id, l.variant_id, l.sku)
                            .some((c) => c.kind === "supplier" || c.kind === "internal") && (
                            <button onClick={() => issueCode(l)} disabled={busy}
                              className="text-xs text-slate-500">{t("labels_issue")}</button>
                          )}
                          {codesFor(l.product_id, l.variant_id, l.sku)
                            .some((c) => c.kind === "supplier") &&
                            !codesFor(l.product_id, l.variant_id, l.sku)
                              .some((c) => c.kind === "internal") && (
                            <span className="text-xs text-amber-700">
                              {t("labels_hasSupplier")}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" value={l.qty} min={0}
                        onChange={(e) => setLines((rows) => rows.map((r) =>
                          r.key === l.key ? { ...r, qty: Number(e.target.value) } : r))}
                        className="w-20 border border-slate-200 rounded px-2 py-1 text-right" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setLines((rows) => rows.filter((r) => r.key !== l.key))}
                        className="text-red-600 text-xs">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Said before the roll is spent, not after. */}
        {noCode.length > 0 && (
          <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-2">
            {t("labels_needCode")} — {noCode.map((l) => l.name).join(", ")}
          </p>
        )}
        {tooNarrow.length > 0 && (
          <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-2">
            {t("labels_tooNarrow")} — {tooNarrow.map((l) => l.name).join(", ")}
          </p>
        )}

        <div className="no-print flex items-center gap-3 mb-6">
          <button
            onClick={() => window.print()}
            disabled={!total || noCode.length > 0}
            className="px-5 py-2 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
            🖨 {t("labels_print")} ({total})
          </button>
          {lines.length > 0 && (
            <button onClick={() => setLines([])} className="text-sm text-slate-500">
              {t("labels_clear")}
            </button>
          )}
        </div>

        <h2 className="text-sm font-medium text-slate-500 mb-2">{t("labels_preview")}</h2>
      </div>

      {/* The sheet itself. Sized in millimetres so what prints is what the
          roll expects, whatever the screen is doing. */}
      <div
        id="sheet"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${size.across}, ${size.w}mm)`,
          width: `${size.across * size.w}mm`,
        }}
      >
        {stickers.map((l, n) => (
          <div
            key={n}
            style={{
              width: `${size.w}mm`,
              height: `${size.h}mm`,
              padding: "1.5mm 2mm",
              boxSizing: "border-box",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              breakInside: "avoid",
            }}
          >
            {showName && (
              <div style={{
                fontSize: "2.2mm", lineHeight: 1.15, textAlign: "center",
                maxHeight: "5mm", overflow: "hidden", marginBottom: "0.8mm",
              }}>
                {l.name}
              </div>
            )}
            <div
              style={{ width: `${barcodeWidth}mm`, height: `${size.h * 0.4}mm` }}
              dangerouslySetInnerHTML={{
                __html: code128Svg(l.code, {
                  widthMm: barcodeWidth,
                  heightMm: size.h * 0.4,
                }),
              }}
            />
            <div style={{ fontSize: "2.2mm", marginTop: "0.6mm", letterSpacing: "0.2mm" }}>
              {l.code}
            </div>
            {showPrice && (
              <div style={{ fontSize: "2.6mm", fontWeight: 600, marginTop: "0.4mm" }}>
                {l.price.toLocaleString()} MMK
              </div>
            )}
          </div>
        ))}
      </div>

      {toast && (
        <div className="no-print fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-5 py-2.5 rounded-lg text-sm z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
