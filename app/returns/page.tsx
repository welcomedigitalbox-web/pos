"use client";

import { useEffect, useState } from "react";
import {
  supabase, SaleReturn, RefundMethod, ItemCondition, SellableItem, fetchSellableItems,
  netLineTotal, uploadReturnVoucher, getVoucherUrl, upsertStoreInventory, logActivity,
} from "@/lib/supabase";
import { useStore } from "../store-context";
import { useAuth } from "../auth-context";
import { useRouter } from "next/navigation";
import { useLanguage } from "../language-context";
import { hasPermission } from "../permissions";

function fmt(n: number) {
  return Number(n || 0).toLocaleString() + " MMK";
}

type OrderItem = {
  id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  line_cogs: number;
  alreadyReturned: number;
  netUnitPrice: number;
  sku: string | null;
};

type DraftLine = { qty: string; condition: ItemCondition };

const statusColor: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

export default function ReturnsPage() {
  const { storeId } = useStore();
  const { profile } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();

  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  // create flow
  const [showCreate, setShowCreate] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [foundSale, setFoundSale] = useState<any | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [refundMethod, setRefundMethod] = useState<RefundMethod>("cash");
  const [refundPaymentMethod, setRefundPaymentMethod] = useState("");
  const [paymentMethods, setPaymentMethods] = useState<{ code: string; name: string }[]>([]);
  const [stockItems, setStockItems] = useState<SellableItem[]>([]);
  const [exchangeLines, setExchangeLines] = useState<{ key: string; qty: number }[]>([]);
  const [exchangeSearch, setExchangeSearch] = useState("");
  const [reason, setReason] = useState("");
  const [voucherFile, setVoucherFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // approval
  const [reviewRow, setReviewRow] = useState<SaleReturn | null>(null);
  const [reviewItems, setReviewItems] = useState<any[]>([]);
  const [voucherLink, setVoucherLink] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [processing, setProcessing] = useState(false);
  const [sendingBack, setSendingBack] = useState<string | null>(null);
  const [approvalPin, setApprovalPin] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [verifying, setVerifying] = useState(false);

  const canApprove =
    profile?.role === "sale_manager" || profile?.role === "owner" || profile?.role === "admin";

  useEffect(() => {
    if (profile && !hasPermission(profile, "returns")) router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  if (!profile || !hasPermission(profile, "returns")) return null;

  async function load() {
    setLoading(true);
    // Returns are filed against the store the ORIGINAL SALE belongs to, which is
    // not always the store currently selected in the nav. Managers therefore see
    // every store, and cashiers see their own — otherwise records "disappear".
    let listQuery = supabase
      .from("sale_returns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (!canApprove) {
      // A branch is involved either as the seller or as the counter that
      // handled the refund - both need it in their history.
      listQuery = listQuery.or(`store_id.eq.${storeId},processed_store_id.eq.${storeId}`);
    }
    const { data } = await listQuery;
    setReturns((data as SaleReturn[]) || []);

    const { data: pm } = await supabase
      .from("payment_methods").select("code, name").eq("is_active", true).order("name");
    setPaymentMethods((pm as any[]) || []);
    if (!refundPaymentMethod && pm?.length) setRefundPaymentMethod(pm[0].code);

    setLoading(false);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  }

  async function findOrder() {
    const q = orderSearch.trim().toLowerCase();
    if (!q) return;

    // Look in this store first. Row-level security scopes `sales` to the
    // cashier's own branch, so anything from elsewhere needs the lookup RPC.
    const { data: local } = await supabase
      .from("sales")
      .select("*")
      .or(`sale_ref.ilike.${q},customer_name.ilike.${q}`)
      .order("created_at", { ascending: false })
      .limit(20);

    let sale = ((local as any[]) || [])[0] || null;
    let remoteItems: any[] | null = null;

    // Not ours: ask the server by exact receipt reference. This allows a
    // lookup, not a search - the cashier must already hold the receipt, and
    // every call is written to the audit log.
    if (!sale) {
      const { data: remote, error: remoteErr } = await supabase
        .rpc("lookup_sale_for_return", { p_sale_ref: orderSearch.trim() });
      const row = ((remote as any[]) || [])[0];
      if (!remoteErr && row) {
        sale = {
          id: row.sale_id,
          sale_ref: row.sale_ref,
          store_id: row.store_id,
          created_at: row.created_at,
          total: row.total,
          subtotal: row.subtotal,
          discount_amount: row.discount_amount,
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          payment_method: row.payment_method,
          cashier_email: row.cashier_email,
        };
        // sale_items is store-scoped too, so a cross-store lookup has to
        // carry its own lines - querying the table returns nothing here.
        remoteItems = (row.items as any[]) || [];
      }
    }

    if (!sale) {
      setFoundSale(null);
      setOrderItems([]);
      return showToast(t("returns_orderNotFound"));
    }

    let items: any[] | null = remoteItems;
    if (!items) {
      const { data: localItems } = await supabase
        .from("sale_items")
        .select("*, products(sku), product_variants(sku)")
        .eq("sale_id", sale.id);
      items = (localItems as any[]) || [];
    }

    // Anything already returned can't be returned twice
    // Query the items directly rather than through a nested select, so a missing
    // relationship can never silently allow the same item to be returned twice.
    const { data: prevReturns } = await supabase
      .from("sale_returns")
      .select("id")
      .eq("original_sale_id", sale.id)
      .neq("status", "rejected");

    const returnedMap = new Map<string, number>();
    const prevIds = ((prevReturns as any[]) || []).map((r) => r.id);
    if (prevIds.length) {
      const { data: prevItems } = await supabase
        .from("sale_return_items")
        .select("product_id, variant_id, qty")
        .in("return_id", prevIds);
      for (const ri of (prevItems as any[]) || []) {
        const k = `${ri.product_id}:${ri.variant_id || "base"}`;
        returnedMap.set(k, (returnedMap.get(k) || 0) + Number(ri.qty));
      }
    }

    setFoundSale(sale);
    setStockItems(await fetchSellableItems(sale.store_id));
    setExchangeLines([]);
    setOrderItems(
      ((items as any[]) || []).map((i) => {
        const net = netLineTotal(i.line_total, sale.subtotal, sale.discount_amount);
        return {
          ...i,
          alreadyReturned: returnedMap.get(`${i.product_id}:${i.variant_id || "base"}`) || 0,
          // Refund what was actually paid per unit, not the pre-discount price
          netUnitPrice: Number(i.qty) > 0 ? net / Number(i.qty) : 0,
          sku: i.product_variants?.sku || i.products?.sku || null,
        };
      })
    );
    setDraft({});
  }

  const returnedTotal = orderItems.reduce((sum, i) => {
    const q = Number(draft[i.id]?.qty || 0);
    return sum + q * i.netUnitPrice;
  }, 0);

  const exchangeTotal = exchangeLines.reduce((sum, l) => {
    const item = stockItems.find((s) => s.key === l.key);
    return sum + (item ? item.price * l.qty : 0);
  }, 0);

  // Positive → the shop owes the customer; negative → the customer owes the shop
  const refundTotal = refundMethod === "exchange" ? returnedTotal - exchangeTotal : returnedTotal;

  async function submitReturn() {
    const lines = orderItems
      .map((i) => ({ item: i, qty: Number(draft[i.id]?.qty || 0), condition: draft[i.id]?.condition || "good" }))
      .filter((l) => l.qty > 0);

    if (!lines.length) return showToast(t("returns_selectItems"));
    if (!voucherFile) return showToast(t("returns_voucherRequired"));
    if (refundMethod === "exchange" && exchangeLines.every((l) => l.qty <= 0))
      return showToast(t("returns_exchangeItemsRequired"));
    for (const l of lines) {
      if (l.qty > l.item.qty - l.item.alreadyReturned) {
        return showToast(`${t("returns_qtyTooHigh")} — ${l.item.product_name}`);
      }
    }

    setSaving(true);
    try {
      // Re-verify now: the screen may have been open while someone else filed a return
      const { data: freshReturns } = await supabase
        .from("sale_returns").select("id").eq("original_sale_id", foundSale.id).neq("status", "rejected");
      const freshIds = ((freshReturns as any[]) || []).map((r) => r.id);
      if (freshIds.length) {
        const { data: freshItems } = await supabase
          .from("sale_return_items").select("product_id, variant_id, qty").in("return_id", freshIds);
        const freshMap = new Map<string, number>();
        for (const ri of (freshItems as any[]) || []) {
          const k = `${ri.product_id}:${ri.variant_id || "base"}`;
          freshMap.set(k, (freshMap.get(k) || 0) + Number(ri.qty));
        }
        for (const l of lines) {
          const k = `${l.item.product_id}:${l.item.variant_id || "base"}`;
          if (l.qty + (freshMap.get(k) || 0) > l.item.qty) {
            setSaving(false);
            return showToast(`${t("returns_qtyTooHigh")} — ${l.item.product_name}`);
          }
        }
      }

      // Cross-store: the return belongs to the selling branch's books, and RLS
      // rightly refuses a cashier writing a row for a store they are not in.
      // The RPC applies the same quantity and pricing rules server side.
      // profile.store_id is the account's actual branch. The store picker's
      // value can lag behind it on first load, and picking the wrong one here
      // sends the insert down the path RLS refuses.
      const myStore = profile?.store_id || storeId;
      const isCrossStore = foundSale.store_id !== myStore;
      if (isCrossStore) {
        if (refundMethod === "exchange") {
          setSaving(false);
          return showToast(t("returns_exchangeSameStoreOnly"));
        }
        const { data: rpcRows, error: rpcErr } = await supabase.rpc("submit_sale_return", {
          p_sale_id: foundSale.id,
          p_lines: lines.map((l) => ({
            product_id: l.item.product_id,
            variant_id: l.item.variant_id,
            qty: l.qty,
            condition: l.condition,
          })),
          p_refund_method: refundMethod,
          p_refund_payment: refundMethod === "cash" ? refundPaymentMethod || null : null,
          p_reason: reason.trim() || null,
        });
        if (rpcErr) throw rpcErr;
        const row = (rpcRows as any[])?.[0];
        if (!row) throw new Error("Return was not created");

        if (voucherFile) {
          try {
            const path = await uploadReturnVoucher(voucherFile, myStore, row.return_id);
            await supabase.from("sale_returns").update({ voucher_url: path }).eq("id", row.return_id);
          } catch {
            // The return itself is filed; a failed voucher upload must not undo it.
          }
        }

        showToast(t("returns_submitted"));
        setShowCreate(false);
        setFoundSale(null);
        setOrderItems([]);
        setVoucherFile(null);
        setReason("");
        setSaving(false);
        await load();
        return;
      }

      const returnNumber = `RT-${Date.now().toString().slice(-8)}`;
      const { data: created, error } = await supabase
        .from("sale_returns")
        .insert({
          return_number: returnNumber,
          original_sale_id: foundSale.id,
          sale_ref: foundSale.sale_ref,
          store_id: foundSale.store_id,
          processed_store_id: storeId,
          customer_id: foundSale.customer_id,
          customer_name: foundSale.customer_name,
          refund_method: refundMethod,
          refund_payment_method: refundMethod === "cash" ? refundPaymentMethod || null : null,
          refund_amount: refundTotal,
          reason: reason.trim() || null,
          requested_by: profile?.email || null,
        })
        .select()
        .single();
      if (error) throw error;

      const returnRows = lines.map((l) => ({
        return_id: created.id,
        product_id: l.item.product_id,
        variant_id: l.item.variant_id,
        product_name: l.item.product_name,
        qty: l.qty,
        unit_price: l.item.netUnitPrice,
        unit_cogs: Number(l.item.qty) > 0 ? Number(l.item.line_cogs) / Number(l.item.qty) : 0,
        condition: l.condition,
        line_type: "return",
      }));

      const exchangeRows = exchangeLines
        .map((l) => {
          const it = stockItems.find((s) => s.key === l.key);
          if (!it || l.qty <= 0) return null;
          return {
            return_id: created.id,
            product_id: it.product_id,
            variant_id: it.variant_id,
            product_name: it.display_name,
            qty: l.qty,
            unit_price: it.price,
            unit_cogs: it.avg_cost,
            condition: "good",
            line_type: "exchange",
          };
        })
        .filter(Boolean);

      await supabase.from("sale_return_items").insert([...returnRows, ...(exchangeRows as any[])]);

      if (voucherFile) {
        const path = await uploadReturnVoucher(voucherFile, storeId, created.id);
        await supabase.from("sale_returns").update({ voucher_url: path }).eq("id", created.id);
      }

      await logActivity({
        entityType: "sale_return",
        entityId: created.id,
        action: "requested",
        detail: `${returnNumber} · ${fmt(refundTotal)} · ${lines.length} item(s)`,
        actor: profile?.email,
      });

      showToast(t("returns_submitted"));
      setShowCreate(false);
      setFoundSale(null);
      setOrderItems([]);
      setDraft({});
      setVoucherFile(null);
      setReason("");
      setExchangeLines([]);
      await load();
      // Open the approval step immediately — the customer is still at the counter
      await openReview({ ...(created as SaleReturn), refund_amount: refundTotal });
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function openReview(r: SaleReturn) {
    setReviewRow(r);
    setRejectReason("");
    setVoucherLink(r.voucher_url ? await getVoucherUrl(r.voucher_url) : null);
    const { data } = await supabase.from("sale_return_items").select("*").eq("return_id", r.id);
    setReviewItems((data as any[]) || []);
  }

  async function approveReturn(approver?: string) {
    if (!reviewRow) return;
    const approvedBy = approver || profile?.email || null;
    setProcessing(true);
    try {
      const handledAt = (reviewRow as any).processed_store_id || reviewRow.store_id;
      const isCrossStore = handledAt !== reviewRow.store_id;
      // Same-store returns land in that store. Cross-store returns belong to the
      // selling branch, so they bypass this store's books entirely.
      let approvalTransferId: string | null = null;
      const stockStore = handledAt;
      for (const item of reviewItems.filter((i) => i.line_type !== "exchange")) {
        if (isCrossStore && item.condition === "good") {
          // Straight into transit — never added to the handling store's stock
          const { data: transitRow } = await supabase.from("stock_transfers").insert({
            product_id: item.product_id,
            variant_id: item.variant_id,
            from_store_id: handledAt,
            to_store_id: reviewRow.store_id,
            qty: item.qty,
            status: "in_transit",
            transferred_by: profile?.email || null,
            sale_return_id: reviewRow.id,
          }).select("id").single();
          // Recording this is what hides "Send back" - without it the operator
          // can open a second transfer for goods already in transit.
          if (transitRow && !approvalTransferId) {
            approvalTransferId = transitRow.id;
            await supabase.from("sale_returns")
              .update({ return_transfer_id: transitRow.id }).eq("id", reviewRow.id);
          }
          continue;
        }

        if (item.condition === "good") {
          // Sellable again — put it back on the shelf at its original cost
          const { data: inv } = await (item.variant_id
            ? supabase.from("store_inventory").select("*").eq("store_id", stockStore)
                .eq("product_id", item.product_id).eq("variant_id", item.variant_id).maybeSingle()
            : supabase.from("store_inventory").select("*").eq("store_id", stockStore)
                .eq("product_id", item.product_id).is("variant_id", null).maybeSingle());

          await upsertStoreInventory(stockStore, item.product_id, item.variant_id, {
            stock_qty: Number(inv?.stock_qty || 0) + Number(item.qty),
          });
        } else {
          // Damaged goods never re-enter sellable stock; log them as a write-off
          await supabase.from("stock_damages").insert({
            store_id: stockStore,
            product_id: item.product_id,
            variant_id: item.variant_id,
            qty: item.qty,
            reason: `Return ${reviewRow.return_number}`,
            reported_by: profile?.email || null,
          });
        }
      }

      // A cross-store return with nothing in good condition has nothing to
      // send anywhere - the damaged goods are written off where they were
      // handed in. Mark it settled so "Send back" stops offering a transfer
      // that would move stock that does not exist.
      if (isCrossStore && !approvalTransferId) {
        const anyGood = reviewItems.some(
          (i) => i.line_type !== "exchange" && i.condition === "good"
        );
        if (!anyGood) {
          await supabase.from("sale_returns")
            .update({ no_transfer_needed: true }).eq("id", reviewRow.id);
        }
      }

      // Replacement goods are a real sale: booking one keeps stock, COGS and
      // every downstream report correct without special-casing exchanges.
      const outLines = reviewItems.filter((i) => i.line_type === "exchange");
      if (outLines.length) {
        const exchangeTotal = outLines.reduce((sum, i) => sum + Number(i.qty) * Number(i.unit_price), 0);
        const { data: exSale, error: exErr } = await supabase
          .from("sales")
          .insert({
            store_id: stockStore,
            subtotal: exchangeTotal,
            total: exchangeTotal,
            payment_method: "exchange",
            order_type: "pos",
            customer_id: reviewRow.customer_id,
            customer_name: reviewRow.customer_name,
            cashier_email: reviewRow.requested_by,
            note: `Exchange for ${reviewRow.return_number}`,
          })
          .select()
          .single();
        if (exErr) throw exErr;

        await supabase.from("sale_items").insert(
          outLines.map((i) => ({
            sale_id: exSale.id,
            product_id: i.product_id,
            variant_id: i.variant_id,
            product_name: i.product_name,
            qty: i.qty,
            unit_price: i.unit_price,
            line_total: Number(i.qty) * Number(i.unit_price),
            unit_cost: i.unit_cogs,
            line_cogs: Number(i.qty) * Number(i.unit_cogs),
          }))
        );

        for (const i of outLines) {
          const { data: inv } = await (i.variant_id
            ? supabase.from("store_inventory").select("*").eq("store_id", stockStore)
                .eq("product_id", i.product_id).eq("variant_id", i.variant_id).maybeSingle()
            : supabase.from("store_inventory").select("*").eq("store_id", stockStore)
                .eq("product_id", i.product_id).is("variant_id", null).maybeSingle());
          await upsertStoreInventory(stockStore, i.product_id, i.variant_id, {
            stock_qty: Number(inv?.stock_qty || 0) - Number(i.qty),
          });
        }

        await supabase.from("sale_returns").update({ exchange_sale_id: exSale.id }).eq("id", reviewRow.id);
      }

      if (isCrossStore && Number(reviewRow.refund_amount) > 0) {
        await supabase.from("inter_store_settlements").insert({
          owing_store_id: reviewRow.store_id,
          owed_store_id: handledAt,
          amount: reviewRow.refund_amount,
          reason: "cross_store_refund",
          sale_return_id: reviewRow.id,
          note: reviewRow.return_number,
          created_by: profile?.email || null,
        });
      }

      // The RPC checks the approver against the selling store's reporting
      // line; a direct update to these columns is refused.
      const { error: apprErr } = await supabase.rpc("approve_sale_return", {
        p_return_id: reviewRow.id,
      });
      if (apprErr) throw apprErr;

      await logActivity({
        entityType: "sale_return",
        entityId: reviewRow.id,
        action: "approved",
        detail: `${reviewRow.return_number} · ${fmt(Number(reviewRow.refund_amount))}`,
        actor: approvedBy,
      });

      showToast(t("returns_approved"));
      setReviewRow(null);
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setProcessing(false);
    }
  }

  async function approveWithPin() {
    if (!approvalPin.trim()) return showToast(t("returns_pinRequired"));
    setVerifying(true);
    try {
      const { data, error } = await supabase.functions.invoke("verify-discount-approver", {
        body: { pin: approvalPin.trim() },
      });
      if (error) throw error;
      if (!data?.approved) {
        showToast("❌ " + (data?.error || t("returns_pinInvalid")));
        return;
      }
      setApprovalPin("");
      await approveReturn(data.approver_email);
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setVerifying(false);
    }
  }

  // Goods returned at another branch still belong to the selling store's books,
  // so they have to physically go back. This opens that transfer.
  async function sendBackToOrigin(r: SaleReturn) {
    const from = (r as any).processed_store_id || r.store_id;
    if (from === r.store_id) return;

    // The row in props may predate an approval that already opened the
    // transfer, so ask the database rather than trusting what is on screen.
    const { data: fresh } = await supabase
      .from("sale_returns").select("return_transfer_id").eq("id", r.id).single();
    if (fresh?.return_transfer_id) {
      return showToast(t("returns_alreadySent") || "Already sent back");
    }
    if (!confirm(t("returns_sendBackConfirm"))) return;

    setSendingBack(r.id);
    try {
      const { data: lines } = await supabase
        .from("sale_return_items")
        .select("product_id, variant_id, qty, condition, line_type")
        .eq("return_id", r.id)
        .eq("line_type", "return")
        .eq("condition", "good");

      const rows = (lines as any[]) || [];
      if (!rows.length) {
        setSendingBack(null);
        return showToast(t("returns_nothingToSend"));
      }

      let firstTransfer: string | null = null;
      for (const l of rows) {
        const { data: inv } = await (l.variant_id
          ? supabase.from("store_inventory").select("*").eq("store_id", from)
              .eq("product_id", l.product_id).eq("variant_id", l.variant_id).maybeSingle()
          : supabase.from("store_inventory").select("*").eq("store_id", from)
              .eq("product_id", l.product_id).is("variant_id", null).maybeSingle());

        await upsertStoreInventory(from, l.product_id, l.variant_id, {
          stock_qty: Math.max(0, Number(inv?.stock_qty || 0) - Number(l.qty)),
        });

        const { data: created, error } = await supabase
          .from("stock_transfers")
          .insert({
            product_id: l.product_id,
            variant_id: l.variant_id,
            from_store_id: from,
            to_store_id: r.store_id,
            qty: l.qty,
            status: "in_transit",
            transferred_by: profile?.email || null,
            sale_return_id: r.id,
          })
          .select()
          .single();
        if (error) throw error;
        if (!firstTransfer) firstTransfer = created.id;
      }

      await supabase.from("sale_returns").update({ return_transfer_id: firstTransfer }).eq("id", r.id);

      await logActivity({
        entityType: "sale_return",
        entityId: r.id,
        action: "sent_back",
        detail: `${r.return_number}: ${from} → ${r.store_id}`,
        actor: profile?.email,
      });

      showToast(t("returns_sentBack"));
      await load();
    } catch (err) {
      showToast("❌ " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSendingBack(null);
    }
  }

  async function rejectReturn() {
    if (!reviewRow || !rejectReason.trim()) return showToast(t("returns_rejectReasonRequired"));
    const { error: rejErr } = await supabase.rpc("approve_sale_return", {
      p_return_id: reviewRow.id,
      p_reject: true,
      p_reason: rejectReason.trim(),
    });
    if (rejErr) return showToast("\u274c " + rejErr.message);
    await logActivity({
      entityType: "sale_return", entityId: reviewRow.id, action: "rejected",
      detail: rejectReason.trim(), actor: profile?.email,
    });
    showToast(t("returns_rejected"));
    setReviewRow(null);
    await load();
  }

  const pending = returns.filter((r) => r.status === "pending").length;
  const awaitingSendBack = returns.filter(
    (r) =>
      r.status === "approved" &&
      (r as any).processed_store_id &&
      (r as any).processed_store_id !== r.store_id &&
      !(r as any).return_transfer_id &&
      !(r as any).no_transfer_needed
  ).length;
  const visibleReturns =
    statusFilter === "all" ? returns : returns.filter((r) => r.status === statusFilter);

  return (
    <div className="pt-4">
      <div className="flex justify-between items-center mb-1">
        <h2 className="font-semibold text-lg">{t("nav_returns")}</h2>
        <button onClick={() => setShowCreate(true)}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg font-medium">
          {t("returns_new")}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-3">
        {t("returns_pending")}: <span className="font-semibold text-orange-600">{pending}</span>
        {awaitingSendBack > 0 && (
          <>
            {" · "}
            <span className="font-semibold text-orange-600">
              {t("returns_awaitingSendBack")}: {awaitingSendBack}
            </span>
          </>
        )}
      </p>

      <select className="border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4"
        value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="all">{t("warehouse_allStock")}</option>
        <option value="pending">{t("returns_status_pending")}</option>
        <option value="approved">{t("returns_status_approved")}</option>
        <option value="rejected">{t("returns_status_rejected")}</option>
      </select>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">{t("returns_number")}</th>
              <th className="text-left px-3 py-2">{t("history_time")}</th>
              {canApprove && <th className="text-left px-3 py-2">{t("admin_store")}</th>}
              <th className="text-left px-3 py-2">{t("pos_customer")}</th>
              <th className="text-left px-3 py-2">{t("returns_refundMethod")}</th>
              <th className="text-left px-3 py-2">{t("returns_refundAmount")}</th>
              <th className="text-left px-3 py-2">{t("saleOrder_status")}</th>
              <th className="text-left px-3 py-2">{t("returns_requestedBy")}</th>
              <th className="text-left px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="text-center text-slate-400 py-8">...</td></tr>}
            {!loading && visibleReturns.map((r) => (
              <tr key={r.id} className={`border-t border-slate-100 ${r.status === "pending" ? "bg-yellow-50" : ""}`}>
                <td className="px-3 py-2 font-mono text-xs">
                  {r.return_number}
                  {(r as any).sale_ref && (
                    <div className="text-slate-400">{(r as any).sale_ref}</div>
                  )}
                </td>
                <td className="px-3 py-2">{new Date(r.created_at).toLocaleString()}</td>
                {canApprove && <td className="px-3 py-2 text-slate-500">{r.store_id}</td>}
                <td className="px-3 py-2">{r.customer_name || "-"}</td>
                <td className="px-3 py-2 text-xs">
                  {t(`returns_method_${r.refund_method}` as any)}
                  {r.refund_payment_method && (
                    <span className="text-slate-400"> · {r.refund_payment_method}</span>
                  )}
                </td>
                <td className="px-3 py-2 font-medium">{fmt(Number(r.refund_amount))}</td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor[r.status]}`}>
                    {t(`returns_status_${r.status}` as any)}
                  </span>
                  {r.rejected_reason && (
                    <div className="text-[10px] text-red-600 mt-0.5">{r.rejected_reason}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs">{r.requested_by || "-"}</td>
                <td className="px-3 py-2 text-right space-x-3">
                  {r.status === "approved" &&
                    (r as any).processed_store_id &&
                    (r as any).processed_store_id !== r.store_id &&
                    !(r as any).return_transfer_id &&
                    !(r as any).no_transfer_needed && (
                      <button onClick={() => sendBackToOrigin(r)} disabled={sendingBack === r.id}
                        className="text-orange-600 text-xs font-medium disabled:text-slate-300">
                        {sendingBack === r.id ? "..." : t("returns_sendBack")}
                      </button>
                    )}
                  <button onClick={() => openReview(r)} className="text-blue-600 text-xs font-medium">
                    {r.status === "pending" ? t("returns_review") : t("products_view")}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && visibleReturns.length === 0 && (
              <tr><td colSpan={9} className="text-center text-slate-400 py-8">-</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-4">{t("returns_new")}</h3>

            <label className="text-sm text-slate-600">{t("orderLookup_orderId")}</label>
            <div className="flex gap-2 mt-1 mb-4">
              <input className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={orderSearch} onChange={(e) => setOrderSearch(e.target.value)}
                placeholder="A1B2C3D4"
                onKeyDown={(e) => e.key === "Enter" && findOrder()} />
              <button onClick={findOrder} className="px-4 py-2 bg-slate-700 text-white rounded-lg text-sm font-medium">
                {t("returns_findOrder")}
              </button>
            </div>

            {foundSale && (
              <>
                <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs text-slate-600 mb-3">
                  {new Date(foundSale.created_at).toLocaleString()} · {foundSale.store_id} · {foundSale.customer_name || "-"}
                  {foundSale.cashier_email ? ` · ${t("pos_cashier")}: ${foundSale.cashier_email}` : ""} ·{" "}
                  {t("pos_total")}: {fmt(foundSale.total)}
                </div>

                {orderItems.every((i) => i.qty - i.alreadyReturned <= 0) && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-3">
                    ⚠️ {t("returns_fullyReturned")}
                  </div>
                )}

                <div className="border border-slate-200 rounded-lg overflow-x-auto mb-3">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                        <th className="text-left px-3 py-2">{t("warehouse_colBarcode")}</th>
                        <th className="text-left px-3 py-2">{t("returns_bought")}</th>
                        <th className="text-left px-3 py-2">{t("returns_returnQty")}</th>
                        <th className="text-left px-3 py-2">{t("returns_condition")}</th>
                        <th className="text-left px-3 py-2">{t("returns_refundAmount")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderItems.map((i) => {
                        const remaining = i.qty - i.alreadyReturned;
                        const q = Number(draft[i.id]?.qty || 0);
                        return (
                          <tr key={i.id} className="border-t border-slate-100">
                            <td className="px-3 py-2">{i.product_name}</td>
                            <td className="px-3 py-2 text-slate-400 text-xs">{i.sku || "-"}</td>
                            <td className="px-3 py-2">
                              {i.qty}
                              {i.alreadyReturned > 0 && (
                                <span className="text-[10px] text-orange-600 ml-1">
                                  ({t("returns_alreadyReturned")} {i.alreadyReturned})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <input type="number" min={0} max={remaining} disabled={remaining <= 0}
                                className="w-20 border border-slate-200 rounded px-2 py-1 text-sm disabled:bg-slate-100"
                                value={draft[i.id]?.qty || ""}
                                onChange={(e) =>
                                  setDraft({ ...draft, [i.id]: { qty: e.target.value, condition: draft[i.id]?.condition || "good" } })
                                } />
                            </td>
                            <td className="px-3 py-2">
                              <select className="border border-slate-200 rounded px-2 py-1 text-xs"
                                value={draft[i.id]?.condition || "good"}
                                onChange={(e) =>
                                  setDraft({ ...draft, [i.id]: { qty: draft[i.id]?.qty || "", condition: e.target.value as ItemCondition } })
                                }>
                                <option value="good">{t("returns_conditionGood")}</option>
                                <option value="damaged">{t("returns_conditionDamaged")}</option>
                              </select>
                            </td>
                            <td className="px-3 py-2 font-medium">{fmt(q * i.netUnitPrice)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {refundMethod === "exchange" && (
                  <div className="border border-blue-200 bg-blue-50/40 rounded-lg p-3 mb-3">
                    <div className="text-sm font-medium mb-2">🔁 {t("returns_exchangeItems")}</div>

                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2"
                      placeholder={t("returns_exchangeSearch")}
                      value={exchangeSearch}
                      onChange={(e) => setExchangeSearch(e.target.value)}
                    />

                    {exchangeSearch.trim() && (
                      <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg bg-white mb-2">
                        {stockItems
                          .filter((it) => {
                            const q = exchangeSearch.trim().toLowerCase();
                            return (
                              it.display_name.toLowerCase().includes(q) ||
                              (it.sku || "").toLowerCase().includes(q)
                            );
                          })
                          .slice(0, 20)
                          .map((it) => (
                            <button
                              key={it.key}
                              type="button"
                              onClick={() => {
                                setExchangeLines((prev) =>
                                  prev.find((l) => l.key === it.key)
                                    ? prev.map((l) => (l.key === it.key ? { ...l, qty: l.qty + 1 } : l))
                                    : [...prev, { key: it.key, qty: 1 }]
                                );
                                setExchangeSearch("");
                              }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100"
                            >
                              {it.display_name}
                              <span className="text-slate-400 text-xs"> · {fmt(it.price)} · {t("barcode_balanceStock")}: {it.stock_qty}</span>
                            </button>
                          ))}
                      </div>
                    )}

                    {exchangeLines.map((l) => {
                      const it = stockItems.find((s) => s.key === l.key);
                      if (!it) return null;
                      return (
                        <div key={l.key} className="flex items-center gap-2 text-sm bg-white rounded px-2 py-1.5 mb-1">
                          <span className="flex-1 min-w-0 truncate">{it.display_name}</span>
                          <input
                            type="number"
                            min={1}
                            max={it.stock_qty}
                            className="w-16 border border-slate-200 rounded px-2 py-1 text-sm"
                            value={l.qty}
                            onChange={(e) =>
                              setExchangeLines((prev) =>
                                prev.map((x) => (x.key === l.key ? { ...x, qty: Number(e.target.value) } : x))
                              )
                            }
                          />
                          <span className="w-28 text-right font-medium">{fmt(it.price * l.qty)}</span>
                          <button type="button" className="text-red-500"
                            onClick={() => setExchangeLines((prev) => prev.filter((x) => x.key !== l.key))}>
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="text-sm text-slate-600">{t("returns_refundMethod")}</label>
                    <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                      value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as RefundMethod)}>
                      <option value="cash">{t("returns_method_cash")}</option>
                      <option value="exchange">{t("returns_method_exchange")}</option>
                    </select>
                  </div>
                  {refundMethod === "cash" && (
                    <div>
                      <label className="text-sm text-slate-600">{t("returns_refundVia")}</label>
                      <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1"
                        value={refundPaymentMethod} onChange={(e) => setRefundPaymentMethod(e.target.value)}>
                        {paymentMethods.map((m) => (
                          <option key={m.code} value={m.code}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="text-sm text-slate-600">
                      {t("returns_voucher")} <span className="text-red-600">*</span>
                    </label>
                    <input type="file" accept="image/*"
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-xs mt-1"
                      onChange={(e) => setVoucherFile(e.target.files?.[0] || null)} required />
                  </div>
                </div>

                <label className="text-sm text-slate-600">{t("returns_reason")}</label>
                <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3" rows={2}
                  value={reason} onChange={(e) => setReason(e.target.value)} />

                <div className="border-t border-slate-200 pt-3 mb-4 space-y-1 text-sm">
                  <div className="flex justify-between text-slate-500">
                    <span>{t("returns_returnedValue")}</span>
                    <span>{fmt(returnedTotal)}</span>
                  </div>
                  {refundMethod === "exchange" && (
                    <div className="flex justify-between text-slate-500">
                      <span>{t("returns_exchangeValue")}</span>
                      <span>-{fmt(exchangeTotal)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-base pt-1">
                    <span>
                      {refundTotal >= 0 ? t("returns_refundAmount") : t("returns_customerPays")}
                    </span>
                    <span className={refundTotal >= 0 ? "" : "text-orange-600"}>
                      {fmt(Math.abs(refundTotal))}
                    </span>
                  </div>
                </div>
              </>
            )}

            <div className="flex gap-2">
              <button onClick={() => { setShowCreate(false); setFoundSale(null); setOrderItems([]); }}
                className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
              <button onClick={submitReturn} disabled={saving || !foundSale || !voucherFile || (refundMethod === "cash" && refundTotal <= 0)}
                className="flex-1 py-2.5 bg-blue-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                {saving ? "..." : t("returns_submit")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review */}
      {reviewRow && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-lg my-8">
            <h3 className="font-semibold text-lg mb-1 font-mono">{reviewRow.return_number}</h3>
            <p className="text-xs text-slate-500 mb-1">
              {t("returns_requestedBy")}: <span className="font-medium text-slate-700">{reviewRow.requested_by || "-"}</span>
              {(reviewRow as any).sale_ref && (
                <>{" · "}<span className="font-mono">{(reviewRow as any).sale_ref}</span></>
              )}
              {" · "}{t("returns_soldAt")}: {reviewRow.store_id}
              {(reviewRow as any).processed_store_id &&
                (reviewRow as any).processed_store_id !== reviewRow.store_id && (
                  <span className="text-orange-600">
                    {" · "}{t("returns_returnedAt")}: {(reviewRow as any).processed_store_id}
                  </span>
                )}
            </p>
            <p className="text-sm text-slate-500 mb-4">
              {reviewRow.customer_name || "-"} · {t(`returns_method_${reviewRow.refund_method}` as any)}
              {reviewRow.refund_payment_method ? ` (${reviewRow.refund_payment_method})` : ""} ·{" "}
              {fmt(Number(reviewRow.refund_amount))}
            </p>

            <div className="border border-slate-200 rounded-lg overflow-hidden mb-3">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">{t("stockIn_product")}</th>
                    <th className="text-left px-3 py-2">{t("ledger_qty")}</th>
                    <th className="text-left px-3 py-2">{t("returns_condition")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewItems.map((i) => (
                    <tr key={i.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{i.product_name}</td>
                      <td className="px-3 py-2">{i.qty}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          i.condition === "good" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                        }`}>
                          {t(i.condition === "good" ? "returns_conditionGood" : "returns_conditionDamaged")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {reviewRow.reason && (
              <p className="text-sm text-slate-600 mb-3">
                <span className="text-xs text-slate-400 uppercase">{t("returns_reason")}</span><br />
                {reviewRow.reason}
              </p>
            )}

            {voucherLink && (
              <a href={voucherLink} target="_blank" rel="noreferrer"
                className="block mb-3 text-sm text-blue-600 font-medium">
                📎 {t("returns_viewVoucher")}
              </a>
            )}

            {reviewRow.status === "pending" && !canApprove && (
              <>
                <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-3">
                  {t("returns_pinHint")}
                </p>
                <label className="text-sm text-slate-600">{t("returns_managerPin")}</label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mt-1 mb-3 tracking-widest text-center"
                  placeholder="••••"
                  value={approvalPin}
                  onChange={(e) => setApprovalPin(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && approveWithPin()}
                />
                <div className="flex gap-2">
                  <button onClick={() => setReviewRow(null)}
                    className="flex-1 py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                    {t("products_cancel")}
                  </button>
                  <button onClick={approveWithPin} disabled={verifying || processing}
                    className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                    {verifying || processing ? "..." : t("returns_approveWithPin")}
                  </button>
                </div>
              </>
            )}

            {reviewRow.status === "pending" && canApprove ? (
              <>
                <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mb-3">
                  {t("returns_approveHint")}
                </p>
                <input className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3"
                  placeholder={t("returns_rejectReason")}
                  value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                <div className="flex gap-2">
                  <button onClick={rejectReturn} disabled={processing}
                    className="flex-1 py-2.5 border border-red-200 text-red-600 rounded-lg text-sm font-medium">
                    {t("returns_reject")}
                  </button>
                  <button onClick={() => approveReturn()} disabled={processing}
                    className="flex-1 py-2.5 bg-green-600 disabled:bg-slate-300 text-white rounded-lg text-sm font-semibold">
                    {processing ? "..." : t("returns_approve")}
                  </button>
                </div>
              </>
            ) : reviewRow.status !== "pending" ? (
              <button onClick={() => setReviewRow(null)}
                className="w-full py-2.5 border border-slate-200 rounded-lg text-sm font-medium">
                {t("products_cancel")}
              </button>
            ) : null}
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
