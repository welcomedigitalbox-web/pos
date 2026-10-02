"use client";
import { useRef, useState, useEffect } from "react";

import { Trash2, Plus, ExternalLink } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { FormField, FormSection } from "@/lib/supabase";

// Figures the form can work out for itself. Typing a percentage that the
// two numbers beside it already imply is an invitation to a wrong one,
// and a difference column is a subtraction nobody should be doing by eye.
//
// Ratios: target = round(of / per * 100, 1)
// Comparison Period ရွေးထားတာနဲ့ အတိုင်းအတာ လိုက်ညှိ
const UNIT_BY_CMP: Record<string, [string, string]> = {
  "1 Day": ["ယခုရက်", "ယခင်ရက်"],
  "1 Week": ["ယခုအပတ်", "ယခင်အပတ်"],
  "1 Month": ["ယခုလ", "ယခင်လ"],
};

const DERIVED: Record<string, { of: string; per: string }> = {
  achievement_pct: { of: "actual_sale", per: "daily_target" },
  conversion_rate: { of: "invoice_count", per: "customer_entrance" },
  attendance_pct:  { of: "present", per: "total_employees" },
  roas:            { of: "sale_amount", per: "ad_spend" },
};

// Quotients: target = round(of / per) — a money figure, not a percentage.
const QUOTIENT: Record<string, { of: string; per: string }> = {
  avg_invoice: { of: "actual_sale", per: "invoice_count" },
  cost_per_result: { of: "amount_spent", per: "result" },
};

// Differences: target = a - b. Warehouse counts what arrived against what
// was sent; stock counts the shelf against the system.
const DIFFERENCE: Record<string, [string, string]> = {
  difference:       ["received_qty", "quantity"],
  cash_difference:  ["physical_closing", "expected_closing"],
  variance:         ["received", "pos_sale"],
};

// Sums: target = the fields listed, added up.
const SUM_OF: Record<string, string[]> = {
  total_received:   ["cash", "kbz", "aya", "kpay", "wave", "other_bank"],
  expected_closing: ["opening_balance", "cash_in"],
};

// The stock exception table subtracts one way and values the result the
// other, so it gets its own pass rather than a third generic rule.
const STOCK_DIFF = { key: "difference", ground: "ground_qty", system: "system_qty" };

type Props = {
  section: FormSection;
  answers: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  readOnly: boolean;
  stores: { id: string; name: string }[];
  people: { id: string; email: string }[];
  // The shop this account works from, so a new row starts where they are.
  defaultStore?: string | null;
};


// Everything a row can work out from what it now holds. Runs on every
// edit rather than on the fields that happen to feed a formula, so a
// value pasted in from anywhere still lands the derived ones.
function recompute(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  const num = (k: string) => Number(out[k]);

  for (const [target, src] of Object.entries(DERIVED)) {
    const top = num(src.of);
    const bottom = num(src.per);
    out[target] =
      Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0
        ? Math.round((top / bottom) * 1000) / 10
        : "";
  }

  for (const [target, src] of Object.entries(QUOTIENT)) {
    const top = num(src.of);
    const bottom = num(src.per);
    out[target] =
      Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0
        ? Math.round(top / bottom)
        : "";
  }

  for (const [target, [a, b]] of Object.entries(DIFFERENCE)) {
    const x = num(a);
    const y = num(b);
    out[target] = Number.isFinite(x) && Number.isFinite(y) ? x - y : "";
  }

  for (const [target, parts] of Object.entries(SUM_OF)) {
    const vals = parts.map(num).filter(Number.isFinite);
    // An untouched section should stay blank rather than reading zero.
    out[target] = vals.length ? vals.reduce((a, b) => a + b, 0) : "";
  }

  // Stock exceptions: the shelf against the books, and what that is worth.
  const ground = num(STOCK_DIFF.ground);
  const system = num(STOCK_DIFF.system);
  if (Number.isFinite(ground) && Number.isFinite(system)) {
    out[STOCK_DIFF.key] = ground - system;
  }

  return out;
}

const COMPUTED = new Set([
  ...Object.keys(DERIVED),
  ...Object.keys(QUOTIENT),
  ...Object.keys(DIFFERENCE),
  ...Object.keys(SUM_OF),
  "target",
]);

// One control per field type. Everything is stored as a string except
// numbers and yes/no, because the answers are jsonb and the form
// definition - not the column - is what says how to read them back.
function Field({
  field,
  value,
  onChange,
  readOnly,
  stores,
  people,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly: boolean;
  stores: Props["stores"];
  people: Props["people"];
}) {
  const base =
    "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500";
  const v = value ?? "";

  // A link that has been pasted into a report is there to be followed. The
  // box stays a box — people still edit it — with the arrow beside it.
  const asUrl = /^https?:\/\/\S+$/i.test(String(v).trim()) ? String(v).trim() : null;
  if (asUrl && field.field_type !== "image" && field.field_type !== "photo") {
    return (
      <div className="flex items-center gap-2">
        <input
          type="text"
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
        <a
          href={asUrl}
          target="_blank"
          rel="noreferrer"
          title={asUrl}
          className="shrink-0 px-2 py-2 text-blue-600 hover:text-blue-700"
        >
          <ExternalLink size={16} />
        </a>
      </div>
    );
  }

  switch (field.field_type) {
    case "textarea":
      return (
        <textarea
          rows={3}
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "number":
    case "money":
    case "percent": {
      // A money box is typed into, not nudged. type="number" put stepper
      // arrows under the MMK label - people were clicking them by accident -
      // and it silently refused "2,292,000", which is how the amounts arrive.
      // So this takes text, keeps only the digits, and shows them grouped.
      const digits = String(v).replace(/[^0-9.]/g, "");
      const shown =
        digits === ""
          ? ""
          : field.field_type === "money"
          ? Number(digits).toLocaleString("en-US")
          : digits;
      return (
        <div className="relative">
          <input
            type="text"
            inputMode="decimal"
            className={base + (field.field_type === "number" ? "" : " pr-12")}
            value={shown}
            disabled={readOnly}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9.]/g, "");
              onChange(raw === "" ? "" : Number(raw));
            }}
          />
          {field.field_type !== "number" && (
            <span className="absolute right-3 top-2 text-xs text-slate-400 pointer-events-none">
              {field.field_type === "money" ? "MMK" : "%"}
            </span>
          )}
        </div>
      );
    }

    case "date":
      return (
        <input
          type="date"
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "time":
      return (
        <input
          type="time"
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case "select":
      return (
        <select
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {(field.options || []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );

    case "yesno":
      // Three states, not two: unanswered is different from "no", and a
      // blank tickbox hides that difference.
      return (
        <div className="flex gap-2">
          {[["yes", "Yes"], ["no", "No"]].map(([val, label]) => (
            <button
              key={val}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(v === val ? "" : val)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                v === val
                  ? val === "yes"
                    ? "bg-green-600 text-white border-green-600"
                    : "bg-red-600 text-white border-red-600"
                  : "border-slate-200 text-slate-600"
              } disabled:opacity-60`}
            >
              {label}
            </button>
          ))}
        </div>
      );

    case "store":
      return (
        <select
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      );

    case "user":
      return (
        <select
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {people.map((p) => (
            <option key={p.id} value={p.email}>{p.email}</option>
          ))}
        </select>
      );

    case "image":
    case "photo":
    case "file":
      return (
        <FileField value={String(v)} readOnly={readOnly} onChange={onChange}
                   image={field.field_type !== "file"} />
      );

    default:
      return (
        <input
          type="text"
          className={base}
          value={String(v)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

// A photo of a new product says more than a line of description, so the box
// takes the picture itself instead of asking for a link to one. The file goes
// to a private bucket and the answer keeps its path; the picture is fetched
// with a signed link each time it is shown.
function FileField({
  value, readOnly, onChange, image,
}: {
  value: string;
  readOnly?: boolean;
  onChange: (v: string) => void;
  image: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string>("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    if (!value || value.startsWith("http")) {
      setUrl(value);
      return;
    }
    supabase.storage.from("report-photos").createSignedUrl(value, 3600)
      .then(({ data }) => { if (alive) setUrl(data?.signedUrl || ""); });
    return () => { alive = false; };
  }, [value]);

  async function upload(file: File) {
    setErr("");
    // A phone camera file is several megabytes; anything past ten is a
    // mistake rather than a photo.
    if (file.size > 10 * 1024 * 1024) {
      setErr("file is larger than 10MB");
      return;
    }
    setBusy(true);
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from("report-photos").upload(path, file);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onChange(path);
  }

  if (readOnly) {
    if (!url) return <span className="text-sm text-slate-400">-</span>;
    return image ? (
      // eslint-disable-next-line @next/next/no-img-element
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt="" className="h-24 rounded-lg border border-slate-200 object-cover" />
      </a>
    ) : (
      <a href={url} target="_blank" rel="noreferrer" className="text-sm text-blue-600">open</a>
    );
  }

  return (
    <div className="space-y-2">
      {url && image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-24 rounded-lg border border-slate-200 object-cover" />
      )}
      <div className="flex items-center gap-2">
        <input
          type="file"
          accept={image ? "image/*" : undefined}
          className="text-sm"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        {busy && <span className="text-xs text-slate-400">…</span>}
        {value && !busy && (
          <button type="button" onClick={() => onChange("")}
                  className="text-xs text-red-600">remove</button>
        )}
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

export default function SectionBlock({
  section, answers, onChange, readOnly, stores, people, defaultStore,
}: Props) {
  // A table section keeps its rows as an array under the section id, so
  // adding a supplier does not need a schema change.
  const rows = (answers[section.id] as Record<string, unknown>[]) || [];
  const targetCache = useRef(new Map<string, number | null>());
  const [dept, setDept] = useState<string>("");
  const [role, setRole] = useState<string>("");
  useEffect(() => {
    supabase.from("profiles").select("department").eq("id", "").maybeSingle();
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: p } = await supabase.from("profiles").select("department").eq("id", data.user.id).maybeSingle();
      setDept(String((p as { department?: string } | null)?.department || ""));
      const { data: pr } = await supabase.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
      setRole(String((pr as { role?: string } | null)?.role || ""));
    });
  }, []);

  // Facebook numbers are already synced nightly, so the marketing table can
  // start filled in rather than being copied across by hand.
  const [pulling, setPulling] = useState(false);
  const sectionKind = /platform activity/i.test(section.title || "")
    ? "daily"
    : /facebook performance/i.test(section.title || "")
    ? "fbperf"
    : /facebook.*kpi tracker/i.test(section.title || "")
    ? "kpi"
    : "";
  const canPull = !!sectionKind;
  const compactTable = /kpi tracker/i.test(section.title || "");
  const facebookSection = /facebook/i.test(section.title || "");
  // How far back the comparison looks, in days.
  function backDays(label: string) {
    if (/year/i.test(label)) return 365;
    if (/month/i.test(label)) return 30;
    if (/week/i.test(label)) return 7;
    return 1;
  }
  function shift(day: string, days: number) {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  async function pullWeekly() {
    const from = String(answers["period_start"] || "");
    const to = String(answers["period_end"] || "");
    if (!from || !to) {
      alert("Report Period · စ နဲ့ ဆုံး ကို အရင်ရွေးပါ");
      return;
    }
    const { data } = await supabase.rpc("mkt_fb_period", { p_from: from, p_to: to });
    const cur = (data as Record<string, unknown>) || {};

    if (sectionKind === "fbperf") {
      for (const k of Object.keys(cur)) {
        if (k !== "kpi") onChange(k, cur[k]);
      }
      return;
    }

    // KPI rows: this period from the range, last period from the same length before it.
    const back = backDays(String(answers["comparison_period"] || "1 Week"));
    const [{ data: withTargets }, { data: prevData }] = await Promise.all([
      supabase.rpc("mkt_kpi_rows", { p_from: from, p_to: to, p_platform: "Facebook" }),
      supabase.rpc("mkt_kpi_rows", {
        p_from: shift(from, back), p_to: shift(to, back), p_platform: "Facebook",
      }),
    ]);
    const prev = (prevData as { kpi: string; this_period: number | null }[]) || undefined;
    type KRow = {
      kpi: string; this_period: number | null; target: number | null;
      good: number | null; lower_is_better: boolean;
    };
    const rowsIn = ((withTargets as KRow[]) || []).length
      ? (withTargets as KRow[])
      : ((cur.kpi as KRow[]) || []);
    const cmpLabel = String(answers["comparison_period"] || "");
    const units = UNIT_BY_CMP[cmpLabel];
    const filled = rowsIn.map((r) => {
      const was = (prev || []).find((x) => x.kpi === r.kpi)?.this_period ?? null;
      const now = r.this_period;
      const pct = was != null && Number(was) !== 0 && now != null
        ? Math.round(((Number(now) - Number(was)) / Number(was)) * 1000) / 10
        : null;
      // Above / On Track / Below, read the right way round for cost metrics.
      let status = "";
      if (now != null && r.target != null) {
        const n = Number(now), t = Number(r.target), g = r.good == null ? null : Number(r.good);
        status = r.lower_is_better
          ? (g != null && n <= g ? "Above Target" : n <= t ? "On Track" : "Below Target")
          : (g != null && n >= g ? "Above Target" : n >= t ? "On Track" : "Below Target");
      }
      return {
        kpi: r.kpi, target: r.target ?? null, this_period: now, last_period: was,
        change_pct: pct,
        this_period_unit: units ? units[0] : "",
        last_period_unit: units ? units[1] : "",
        status,
      };
    });
    const seen = new Set(rows.map((r) => String(r.kpi ?? "")));
    onChange(section.id, [...rows, ...filled.filter((r) => !seen.has(r.kpi))]);
  }

  async function pullDaily() {
    {
      const id = window.location.pathname.split("/").filter(Boolean).pop() || "";
      const { data: sub } = await supabase
        .from("report_submissions").select("report_date").eq("id", id).maybeSingle();
      const day = (sub as { report_date?: string } | null)?.report_date;
      if (!day) return;
      const { data } = await supabase.rpc("mkt_day_prefill", { p_date: day });
      const pulled = (data as Record<string, unknown>[]) || [];
      if (!pulled.length) return;
      // Keep whatever was typed by hand; add only campaigns not already listed.
      const seen = new Set(rows.map((r) => String(r.campaign ?? r.platform ?? "")));
      const add = pulled.filter((r) => !seen.has(String(r.campaign ?? r.platform ?? "")));
      onChange(section.id, [...rows, ...add]);
    }
  }

  // A KPI row works out its own change and verdict, whether the numbers were
  // pulled from Facebook or typed in by hand for TikTok.
  const kpiPlatform = /tiktok/i.test(section.title || "") ? "TikTok" : "Facebook";
  function periodName() {
    const a = String(answers["period_start"] || "");
    const b = String(answers["period_end"] || "");
    if (!a || !b) return "weekly";
    const days = Math.round(
      (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000
    );
    return days >= 27 ? "monthly" : days >= 5 ? "weekly" : "daily";
  }
  function verdict(now: number | null, target: number | null, good: number | null, lower: boolean) {
    if (now == null || target == null) return "";
    if (lower) return good != null && now <= good ? "Above Target" : now <= target ? "On Track" : "Below Target";
    return good != null && now >= good ? "Above Target" : now >= target ? "On Track" : "Below Target";
  }
  function kpiMath(r: Record<string, unknown>, t?: { target: number | null; good: number | null; lower_is_better: boolean }) {
    const now = r.this_period == null || r.this_period === "" ? null : Number(r.this_period);
    const was = r.last_period == null || r.last_period === "" ? null : Number(r.last_period);
    const target = t ? t.target : (r.target == null || r.target === "" ? null : Number(r.target));
    const good = t ? t.good : null;
    const lower = t ? t.lower_is_better : /cost/i.test(String(r.kpi || ""));
    const pct = was != null && was !== 0 && now != null
      ? Math.round(((now - was) / was) * 1000) / 10
      : r.change_pct ?? null;
    return {
      ...r,
      ...(target == null ? {} : { target }),
      change_pct: pct,
      status: verdict(now, target, good, lower) || r.status || "",
    };
  }

  function setRow(i: number, key: string, value: unknown) {
    const next = rows.map((r, idx) =>
      idx === i ? recompute({ ...r, [key]: value }) : r
    );

    if (compactTable) {
      // KPI rows: redo the sums here rather than waiting for a pull.
      onChange(section.id, next.map((r, idx) => (idx === i ? kpiMath(r) : r)));
      if (key === "kpi" && value) {
        supabase
          .from("report_targets")
          .select("target_value, good_value, lower_is_better, effective_from")
          .eq("department", "marketing")
          .eq("scope", kpiPlatform)
          .eq("period", periodName())
          .eq("metric_key", String(value))
          .lte("effective_from", String(answers["period_end"] || new Date().toISOString().slice(0, 10)))
          .order("effective_from", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then(({ data }) => {
            const row = data as { target_value: number | null; good_value: number | null; lower_is_better: boolean } | null;
            if (!row) return;
            const t = { target: row.target_value, good: row.good_value, lower_is_better: row.lower_is_better };
            onChange(section.id, next.map((r, idx) => (idx === i ? kpiMath(r, t) : r)));
          });
      }
      return;
    }

    onChange(section.id, next);

    // Picking a KPI pulls the target the manager set, so nobody types it in.
    if (key === "kpi" && value) {
      const metric = String(value);
      const cached = targetCache.current.get(metric);
      const apply = (v: number | null) => {
        if (v == null) return;
        onChange(section.id, next.map((r, idx) =>
          idx === i ? recompute({ ...r, target: v }) : r
        ));
      };
      if (cached !== undefined) { apply(cached); return; }
      supabase.rpc("get_target", { p_metric: metric, p_department: dept || null })
        .then(({ data }) => {
          const v = data == null ? null : Number(data);
          targetCache.current.set(metric, v);
          apply(v);
        });

      // Comparison Period က အတိုင်းအတာကို ပြောပြီးသား, ပြီးတော့ အရင်ကာလ data ကို ဆွဲ
      const cmp = String(answers["comparison_period"] || "");
      const units = UNIT_BY_CMP[cmp];
      const unit = units ? units[0] : String((next[i] || {}).this_period_unit || "");
      const prevUnit = units ? units[1] : String((next[i] || {}).last_period_unit || "");
      supabase
        .rpc("get_prev_kpi", {
          p_form_id: section.form_id,
          p_kpi: metric,
          p_before: String(answers["period_start"] || new Date().toISOString().slice(0, 10)),
          p_unit: prevUnit || unit,
        })
        .then(({ data }) => {
          onChange(section.id, next.map((r, idx) => idx !== i ? r : recompute({
            ...r,
            ...(units ? { this_period_unit: units[0], last_period_unit: units[1] } : {}),
            ...(data == null ? {} : { last_period: Number(data) }),
          })));
        });
    }
  }

  // The manager writes his review inside the same report; nobody else sees it
  // while it is still blank. Once he has written something it belongs to the
  // person who filed the report, read-only.
  const managerOnly = /manager review/i.test(section.title || "");
  const isManager = /manager|director|owner|admin|^om$/i.test(role);

  const reviewMode = managerOnly && isManager;
  const [reviewDraft, setReviewDraft] = useState<Record<string, unknown>>({});
  const [savingReview, setSavingReview] = useState(false);
  const [reviewMsg, setReviewMsg] = useState("");
  async function saveReview() {
    setSavingReview(true);
    setReviewMsg("");
    try {
      const id = window.location.pathname.split("/").filter(Boolean).pop() || "";
      const { data: sub } = await supabase
        .from("report_submissions").select("answers").eq("id", id).maybeSingle();
      const merged = {
        ...(((sub as { answers?: Record<string, unknown> } | null)?.answers) || {}),
        ...reviewDraft,
      };
      const { error } = await supabase
        .from("report_submissions").update({ answers: merged }).eq("id", id);
      setReviewMsg(error ? error.message : "သိမ်းပြီး");
    } finally {
      setSavingReview(false);
    }
  }

  const reviewWritten = section.fields.some((f) => {
    const a = answers[f.key];
    return a !== undefined && a !== null && a !== "";
  });
  if (managerOnly && !isManager && !reviewWritten) return null;

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-sm">{section.title}</h3>
          {canPull && !readOnly && (
            <button type="button" disabled={pulling}
              onClick={async () => {
                setPulling(true);
                try { await (sectionKind === "daily" ? pullDaily() : pullWeekly()); }
                finally { setPulling(false); }
              }}
              className="px-2 py-1 text-xs border border-slate-200 rounded-lg whitespace-nowrap">
              {pulling ? "..." : "Facebook ကနေ ဆွဲယူ"}
            </button>
          )}
        </div>
        {section.title_mm && (
          <p className="text-xs text-slate-500 mt-0.5">{section.title_mm}</p>
        )}
      </div>

      {section.is_table && compactTable ? (
        <div className="p-4 overflow-x-auto">
          {rows.length === 0 && (
            <p className="text-sm text-slate-400 mb-3">No rows yet</p>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  {section.fields.map((f) => (
                    <th key={f.id} className="py-2 pr-2 font-normal whitespace-nowrap">{f.label}</th>
                  ))}
                  {!readOnly && <th className="w-8" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0 align-top">
                    {section.fields.map((f) => (
                      <td key={f.id} className="py-1.5 pr-2 min-w-[7rem]">
                        <Field
                          field={f}
                          value={row[f.key]}
                          onChange={(v) => setRow(i, f.key, v)}
                          readOnly={readOnly || COMPUTED.has(f.key)}
                          stores={stores}
                          people={people}
                        />
                      </td>
                    ))}
                    {!readOnly && (
                      <td className="py-1.5">
                        <button
                          type="button"
                          onClick={() => onChange(section.id, rows.filter((_, x) => x !== i))}
                          className="text-red-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange(section.id, [...rows, {}])}
              className="flex items-center gap-1.5 text-sm text-blue-600 font-medium mt-3"
            >
              <Plus size={14} /> Add row
            </button>
          )}
        </div>
      ) : section.is_table ? (
        <div className="p-4">
          {rows.length === 0 && (
            <p className="text-sm text-slate-400 mb-3">No rows yet</p>
          )}

          {rows.map((row, i) => (
            <div key={i} className="border border-slate-200 rounded-lg p-3 mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-slate-400">#{i + 1}</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onChange(section.id, rows.filter((_, x) => x !== i))}
                    className="text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {section.fields.map((f) => (
                  <div key={f.id}>
                    <label className="text-xs text-slate-600 block mb-1">
                      {f.label}
                      {f.required && <span className="text-red-500 ml-0.5">*</span>}
                    </label>
                    <Field
                      field={f}
                      value={row[f.key]}
                      onChange={(v) => setRow(i, f.key, v)}
                      readOnly={readOnly || COMPUTED.has(f.key)}
                      stores={stores}
                      people={people}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {!readOnly && (
            <button
              type="button"
              onClick={() => {
                const seed: Record<string, unknown> = {};
                const storeField = section.fields.find((f) => f.field_type === "store");
                if (storeField && defaultStore) seed[storeField.key] = defaultStore;
                onChange(section.id, [...rows, seed]);
              }}
              className="flex items-center gap-1.5 text-sm text-blue-600 font-medium"
            >
              <Plus size={14} /> Add row
            </button>
          )}
        </div>
      ) : (
        <div className="p-4 grid sm:grid-cols-2 gap-4">
          {section.fields.map((f) => (
            <div key={f.id}>
              <label className="text-sm text-slate-600 block mb-1">
                {f.label}
                {f.required && <span className="text-red-500 ml-0.5">*</span>}
                {f.label_mm && (
                  <span className="text-xs text-slate-400 block">{f.label_mm}</span>
                )}
              </label>
              <Field
                field={f}
                value={reviewMode ? (reviewDraft[f.key] ?? answers[f.key]) : answers[f.key]}
                onChange={(v) => {
                  if (reviewMode) {
                    // The report is filed; only this card is still being written.
                    setReviewDraft((d) => ({ ...d, [f.key]: v }));
                    if (!readOnly) onChange(f.key, v);
                    return;
                  }
                  // A plain section is one flat set of answers, so the
                  // recompute runs across the whole submission.
                  const next = recompute({ ...answers, [f.key]: v });
                  for (const k of [f.key, ...COMPUTED]) {
                    if (next[k] !== answers[k]) onChange(k, next[k]);
                  }
                }}
                readOnly={reviewMode ? false : readOnly || COMPUTED.has(f.key)}
                stores={stores}
                people={people}
              />
            </div>
          ))}
          {reviewMode && readOnly && (
            <div className="sm:col-span-2 flex items-center gap-3 pt-1">
              <button type="button" onClick={saveReview} disabled={savingReview}
                className="px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm">
                {savingReview ? "..." : "သုံးသပ်ချက် သိမ်း"}
              </button>
              {reviewMsg && <span className="text-sm text-slate-600">{reviewMsg}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
