"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Plus } from "lucide-react";
import {
  supabase, STATUS_TONE,
  type ReportForm, type Submission,
} from "@/lib/supabase";
import { useAuth, isDirector } from "./auth-context";

const today = () => new Date().toISOString().slice(0, 10);

export default function HomePage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [forms, setForms] = useState<ReportForm[]>([]);
  const [mine, setMine] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickDate, setPickDate] = useState(today());
  const BACK_DAYS = 7;
  const minDate = new Date(Date.now() - BACK_DAYS * 864e5).toISOString().slice(0, 10);
  const isLate = pickDate !== today();
  const [error, setError] = useState("");

  useEffect(() => {
    if (isDirector(profile?.role)) {
      router.replace("/dashboard");
      return;
    }
    if (profile) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  async function load() {
    setLoading(true);

    // Your department's forms, unless you are a director - they answer for
    // all of them and file none.
    const q = supabase.from("report_forms").select("*").eq("active", true).order("sort_order");
    const { data: f } = isDirector(profile?.role) || !profile?.department
      ? await q
      : await q.eq("department", profile.department);

    // A form can be addressed to particular people as well as to roles —
    // two staff on the same role each file their own report, and a role list
    // cannot tell them apart.
    const forRole = ((f as ReportForm[]) || []).filter((x) => {
      const y = x as ReportForm & { allowed_roles?: string[]; allowed_emails?: string[] };
      const emails = y.allowed_emails;
      if (emails?.length) return emails.includes(profile!.email);
      const roles = y.allowed_roles;
      return !roles?.length || roles.includes(profile!.role);
    });

    const { data: s } = await supabase
      .from("report_submissions")
      .select("*")
      .eq("created_by", profile!.email)
      .order("report_date", { ascending: false })
      .limit(30);

    // A shared form is one report a day that the team fills in together, so
    // it belongs on everyone's list whoever happened to open it first.
    const sharedIds = forRole.filter((x) => x.is_shared).map((x) => x.id);
    const { data: shared } = sharedIds.length
      ? await supabase
          .from("report_submissions")
          .select("*")
          .in("form_id", sharedIds)
          .order("report_date", { ascending: false })
          .limit(30)
      : { data: [] as Submission[] };

    const byId = new Map<string, Submission>();
    for (const row of [...((s as Submission[]) || []), ...((shared as Submission[]) || [])]) {
      byId.set(row.id, row);
    }

    setForms(forRole);
    setMine(
      [...byId.values()].sort((a, b) =>
        String(b.report_date).localeCompare(String(a.report_date))
      )
    );
    setLoading(false);
  }

  // Today's report for a form, if it has been started.
  const todays = useMemo(() => {
    const map = new Map<string, Submission>();
    for (const s of mine) if (s.report_date === pickDate) map.set(s.form_id, s);
    return map;
  }, [mine, pickDate]);

  async function openForm(form: ReportForm) {
    const existing = todays.get(form.id);
    if (existing) return router.push(`/report/${existing.id}`);

    setBusy(form.id);
    setError("");
    try {
      // On a shared form the second person to arrive joins the report the
      // first one started rather than being turned away from it.
      if (form.is_shared) {
        const { data: already } = await supabase
          .from("report_submissions")
          .select("id")
          .eq("form_id", form.id)
          .eq("report_date", pickDate)
          .limit(1)
          .maybeSingle();
        if (already) {
          return router.push(`/report/${(already as { id: string }).id}`);
        }
      }

      // The store is the one this account works from. A head covering
      // several files against none of them in particular.
      const { data, error: err } = await supabase
        .from("report_submissions")
        .insert({
          form_id: form.id,
          store_id: profile?.store_id || null,
          report_date: pickDate,
          created_by: profile!.email,
          answers: {},
        })
        .select()
        .single();

      if (err) throw err;
      router.push(`/report/${(data as Submission).id}`);
    } catch (e) {
      const msg = (e as { message?: string })?.message || String(e);
      // The unique index does the work of "one per day" - if someone else
      // in the department already opened it, say so rather than failing.
      setError(msg.includes("duplicate") ? `${pickDate} အတွက် report တင်ပြီးသား (သို့) တခြားသူ စဖွင့်ထားပါတယ်။` : msg);
      setBusy(null);
    }
  }

  // A draft has not been filed yet, so it is not a record — the person who
  // started it by mistake should be able to take it back. Anything already
  // submitted goes through a cancel request instead, and the delete policy in
  // the database enforces that whatever this screen offers.
  async function deleteDraft(s: Submission) {
    const form = forms.find((f) => f.id === s.form_id);
    if (!confirm(`${form?.name || s.form_id} · ${s.report_date} ကို ဖျက်မလား?`)) return;

    setBusy(s.id);
    setError("");
    const { error: err } = await supabase
      .from("report_submissions")
      .delete()
      .eq("id", s.id);
    setBusy(null);

    if (err) {
      setError(err.message);
      return;
    }
    setMine((rows) => rows.filter((r) => r.id !== s.id));
  }

  if (authLoading || loading) {
    return <div className="pt-16 text-center text-sm text-slate-400">…</div>;
  }

  if (!profile) return null;

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-1">Today</h1>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <input type="date" value={pickDate} min={minDate} max={today()}
          onChange={(e) => setPickDate(e.target.value || today())}
          className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
        {isLate ? (
          <>
            <span className="text-xs px-2 py-1 rounded bg-amber-50 text-amber-700">နောက်ကျတင်</span>
            <button onClick={() => setPickDate(today())} className="text-xs text-blue-600">ဒီနေ့သို့</button>
          </>
        ) : <span className="text-xs text-slate-400">ဒီနေ့</span>}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3 mb-10">
        {forms.map((f) => {
          const started = todays.get(f.id);
          return (
            <button
              key={f.id}
              onClick={() => openForm(f)}
              disabled={busy === f.id}
              className="bg-white border border-slate-200 rounded-xl p-4 text-left hover:border-blue-300 transition disabled:opacity-50"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-sm">{f.name}</div>
                  {f.name_mm && (
                    <div className="text-xs text-slate-500 mt-0.5">{f.name_mm}</div>
                  )}
                </div>
                {started ? (
                  <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${STATUS_TONE[started.status]}`}>
                    {started.status.replace("_", " ")}
                  </span>
                ) : (
                  <Plus size={16} className="text-slate-400 shrink-0 mt-0.5" />
                )}
              </div>
            </button>
          );
        })}
        {forms.length === 0 && (
          <p className="text-sm text-slate-400 col-span-2 py-8 text-center border border-slate-200 rounded-xl">
            No forms for your department yet
          </p>
        )}
      </div>

      <h2 className="font-semibold mb-3">Recent</h2>
      <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
        {mine.map((s) => {
          const form = forms.find((f) => f.id === s.form_id);
          return (
            <div key={s.id} className="flex items-center hover:bg-slate-50">
              <button
                onClick={() => router.push(`/report/${s.id}`)}
                className="flex-1 flex items-center justify-between px-4 py-3 text-left min-w-0"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText size={16} className="text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm truncate">{form?.name || s.form_id}</div>
                    <div className="text-xs text-slate-400">
                      {s.report_date}
                      {s.store_id && ` · ${s.store_id}`}
                    </div>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${STATUS_TONE[s.status]}`}>
                  {s.status.replace("_", " ")}
                </span>
              </button>
              {s.status === "draft" && (
                <button
                  onClick={() => deleteDraft(s)}
                  disabled={busy === s.id}
                  className="px-3 py-3 text-xs text-red-600 disabled:opacity-40 shrink-0"
                >
                  ဖျက်
                </button>
              )}
            </div>
          );
        })}
        {mine.length === 0 && (
          <p className="text-sm text-slate-400 py-8 text-center">Nothing filed yet</p>
        )}
      </div>
    </div>
  );
}
