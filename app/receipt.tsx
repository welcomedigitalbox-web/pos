"use client";

function fmt(n: number) {
  return n.toLocaleString();
}

function mmk(n: number) {
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

const RULE = { borderTop: "1px solid #ddd", margin: "10px 0" };
const ROW = { display: "flex", justifyContent: "space-between", gap: 12 };
const MUTED = { color: "#888" };

export default function Receipt({ data }: { data: ReceiptData | null }) {
  if (!data) return null;

  const d = new Date(data.createdAt);
  const date = d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear();

  return (
    <div id="receipt-print" style={{ fontSize: 12, lineHeight: 1.45 }}>
      <div style={{ textAlign: "center", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: 0.3 }}>
          {data.businessName || data.storeId}
        </div>
        {data.logoText && <div style={{ ...MUTED, fontSize: 11 }}>{data.logoText}</div>}
        {data.address && <div style={{ ...MUTED, fontSize: 11 }}>{data.address}</div>}
        {data.phone && <div style={{ ...MUTED, fontSize: 11 }}>{data.phone}</div>}
      </div>

      <div style={RULE} />

      <div style={ROW}>
        <span style={{ fontWeight: 700 }}>{data.saleRef}</span>
        <span style={MUTED}>{date}</span>
      </div>

      {(data.customerName || data.cashierEmail) && (
        <>
          <div style={RULE} />
          {data.customerName && (
            <>
              <div style={{ ...MUTED, fontSize: 11 }}>Customer</div>
              <div style={{ fontWeight: 600 }}>{data.customerName}</div>
            </>
          )}
          {data.cashierEmail && (
            <div style={{ ...MUTED, fontSize: 11, marginTop: 2 }}>{data.cashierEmail}</div>
          )}
        </>
      )}

      <div style={RULE} />

      <div style={{ ...ROW, ...MUTED, fontSize: 11, marginBottom: 6 }}>
        <span>Item</span>
        <span>Amount</span>
      </div>

      {data.items.map((item, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={ROW}>
            <span>{item.name}</span>
            <span style={{ whiteSpace: "nowrap" }}>{fmt(item.lineTotal)}</span>
          </div>
          <div style={{ ...MUTED, fontSize: 11 }}>
            {item.qty} × {fmt(item.price)}
          </div>
        </div>
      ))}

      <div style={RULE} />

      <div style={ROW}>
        <span>Subtotal</span>
        <span>{mmk(data.subtotal)}</span>
      </div>
      {data.discountAmount > 0 && (
        <div style={ROW}>
          <span>Discount ({data.discountLabel})</span>
          <span>-{mmk(data.discountAmount)}</span>
        </div>
      )}
      {data.vatAmount > 0 && (
        <div style={ROW}>
          <span>VAT ({data.vatPercent}%)</span>
          <span>{mmk(data.vatAmount)}</span>
        </div>
      )}

      <div style={{ ...ROW, fontWeight: 700, fontSize: 14, marginTop: 10 }}>
        <span>Total</span>
        <span>{mmk(data.grandTotal)}</span>
      </div>

      <div style={RULE} />

      <div style={ROW}>
        <span style={MUTED}>Payment</span>
        <span>{data.paymentMethod}</span>
      </div>
      {data.paymentMethod === "Cash" && (
        <>
          <div style={ROW}>
            <span style={MUTED}>Received</span>
            <span>{mmk(data.amountReceived)}</span>
          </div>
          <div style={ROW}>
            <span style={MUTED}>Change</span>
            <span>{mmk(data.change)}</span>
          </div>
        </>
      )}
      {data.paymentMethod === "COD" && data.advancePayment > 0 && (
        <>
          <div style={ROW}>
            <span style={MUTED}>Advance paid</span>
            <span>{mmk(data.advancePayment)}</span>
          </div>
          <div style={{ ...ROW, fontWeight: 600 }}>
            <span>Balance due</span>
            <span>{mmk(data.balanceDue)}</span>
          </div>
          {data.change > 0 && (
            <div style={ROW}>
              <span style={MUTED}>Change</span>
              <span>{mmk(data.change)}</span>
            </div>
          )}
        </>
      )}

      {data.note && (
        <>
          <div style={RULE} />
          <div style={{ ...MUTED, fontSize: 11 }}>{data.note}</div>
        </>
      )}

      <div style={{ textAlign: "center", marginTop: 16, fontSize: 11, ...MUTED }}>
        {data.footerText || "Thank you!"}
      </div>
    </div>
  );
}
