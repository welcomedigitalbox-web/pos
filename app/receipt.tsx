"use client";

function fmt(n: number) {
  return n.toLocaleString() + " MMK";
}

export type ReceiptData = {
  storeId: string;
  businessName: string | null;
  phone: string | null;
  address: string | null;
  footerText: string | null;
  logoText: string | null;
  saleRef: string;
  createdAt: string;
  items: { name: string; qty: number; price: number; lineTotal: number }[];
  subtotal: number;
  discountLabel: string;
  discountAmount: number;
  vatPercent: number;
  vatAmount: number;
  grandTotal: number;
  paymentMethod: string;
  amountReceived: number;
  change: number;
  advancePayment: number;
  balanceDue: number;
  note: string;
  customerName: string;
  cashierEmail: string;
};

export default function Receipt({ data }: { data: ReceiptData | null }) {
  if (!data) return null;

  return (
    <div id="receipt-print">
      <div style={{ textAlign: "center", marginBottom: 8 }}>
        {data.logoText && <div style={{ fontSize: 20 }}>{data.logoText}</div>}
        <div style={{ fontWeight: "bold", fontSize: 14 }}>{data.businessName || data.storeId}</div>
        {data.address && <div>{data.address}</div>}
        {data.phone && <div>{data.phone}</div>}
        <div>{new Date(data.createdAt).toLocaleString()}</div>
        <div>Receipt: {data.saleRef}</div>
        {data.customerName && <div>Customer: {data.customerName}</div>}
        {data.cashierEmail && <div>Cashier: {data.cashierEmail}</div>}
      </div>
      <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      {data.items.map((item, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{item.name}</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>
              {item.qty} x {fmt(item.price)}
            </span>
            <span>{fmt(item.lineTotal)}</span>
          </div>
        </div>
      ))}
      <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Subtotal</span>
        <span>{fmt(data.subtotal)}</span>
      </div>
      {data.discountAmount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Discount ({data.discountLabel})</span>
          <span>-{fmt(data.discountAmount)}</span>
        </div>
      )}
      {data.vatAmount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>VAT ({data.vatPercent}%)</span>
          <span>{fmt(data.vatAmount)}</span>
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontWeight: "bold",
          fontSize: 13,
          borderTop: "1px solid #000",
          marginTop: 4,
          paddingTop: 4,
        }}
      >
        <span>TOTAL</span>
        <span>{fmt(data.grandTotal)}</span>
      </div>
      <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Payment</span>
        <span>{data.paymentMethod}</span>
      </div>
      {data.paymentMethod === "Cash" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Received</span>
            <span>{fmt(data.amountReceived)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Change</span>
            <span>{fmt(data.change)}</span>
          </div>
        </>
      )}
      {data.paymentMethod === "COD" && data.advancePayment > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Advance Paid</span>
            <span>{fmt(data.advancePayment)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Balance Due</span>
            <span>{fmt(data.balanceDue)}</span>
          </div>
          {data.change > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Change</span>
              <span>{fmt(data.change)}</span>
            </div>
          )}
        </>
      )}
      {data.note && (
        <>
          <div style={{ borderTop: "1px dashed #000", margin: "6px 0" }} />
          <div>Note: {data.note}</div>
        </>
      )}
      <div style={{ textAlign: "center", marginTop: 10 }}>{data.footerText || "Thank you!"}</div>
    </div>
  );
}
