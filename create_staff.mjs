#!/usr/bin/env node
/**
 * Creates the staff accounts that do not exist yet.
 *
 * The admin Edge Function only knows about role, store and permissions,
 * so the department and reporting fields go on in a second step - the
 * same gap the form has. Accounts that already exist are skipped rather
 * than failing the run, so this is safe to repeat.
 *
 * Password is the email, per the client's request for the pilot. That is
 * fine for a handful of trusted staff and wrong for seventy: everyone
 * knows everyone's email. Change it before the wider rollout.
 *
 * Run:  node create_staff.mjs
 */

import { createClient } from "@supabase/supabase-js";

const URL = "https://gbegeetiamspfaqhadhc.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error("Set SUPABASE_SERVICE_KEY first — Dashboard → API Keys → secret key");
  process.exit(1);
}

const db = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// email, role, department, store, is_dept_head
const STAFF = [
  // Sale — one till per shop, plus the channels that have no shop floor
  ["sales-wzyt@edu.com",      "cashier",             "sale",          "WZYT_STORE", false],
  ["sales-bak@edu.com",       "cashier",             "sale",          "BAK_STORE",  false],
  ["sales-nokl@edu.com",      "cashier",             "sale",          "NOKL_STORE", false],
  ["sales-online@edu.com",    "online_sale",         "sale",          null,         false],
  ["sales-wholesale@edu.com", "wholesale",           "sale",          null,         false],

  // Accounts — one accountant role covers the desks; the senior signs off
  ["acc-senior@edu.com",      "finance_manager",     "finance",       null,         true],
  ["acc-payable@edu.com",     "accountant",          "finance",       null,         false],
  ["acc-receivable@edu.com",  "accountant",          "finance",       null,         false],
  ["acc-cashier@edu.com",     "accountant",          "finance",       null,         false],
  ["acc-inventory@edu.com",   "accountant",          "finance",       null,         false],

  // Merchandising
  ["merch-manager@edu.com",   "merchandising_manager", "merchandising", null,       true],
  ["merch-exec1@edu.com",     "merchandising_staff",   "merchandising", null,       false],
  ["merch-exec2@edu.com",     "merchandising_staff",   "merchandising", null,       false],

  // Warehouse — each runs one warehouse and answers for it
  ["wh-ygn@edu.com",          "warehouse_manager",   "warehouse",     "YGN-WH",     true],
  ["wh-mdy@edu.com",          "warehouse_manager",   "warehouse",     "MDY-WH",     true],

  // No shop, no warehouse: they work across the company
  ["hr@edu.com",              "hr_manager",          "sale",          null,         false],
  ["cctv@edu.com",            "it_staff",            "sale",          null,         false],
  ["operation@edu.com",       "operation_director",  null,            null,         false],
];

// Which shops a warehouse manager covers, so the ledger and the approval
// checks know what is theirs.
const SCOPE = {
  "wh-ygn@edu.com": ["YGN-WH", "BAK_STORE", "NOKL_STORE", "WZYT_STORE"],
  "wh-mdy@edu.com": ["MDY-WH", "MDY_STORE"],
  "sales-manager@edu.com": ["BAK_STORE", "NOKL_STORE", "WZYT_STORE", "MDY_STORE"],
};

const { data: existing } = await db.from("profiles").select("email");
const have = new Set((existing || []).map((p) => p.email));

let made = 0;
let skipped = 0;

for (const [email, role, department, store_id, is_dept_head] of STAFF) {
  if (have.has(email)) {
    console.log(`  skip  ${email} (already there)`);
    skipped++;
    continue;
  }

  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password: email,
    email_confirm: true,
  });

  if (error) {
    console.error(`  FAIL  ${email}: ${error.message}`);
    continue;
  }

  // The signup trigger writes a bare profile; this fills in the rest.
  const { error: upErr } = await db
    .from("profiles")
    .update({ role, department, store_id, is_dept_head })
    .eq("id", created.user.id);

  if (upErr) {
    console.error(`  PARTIAL ${email}: account made, profile failed — ${upErr.message}`);
    continue;
  }

  const stores = SCOPE[email];
  if (stores?.length) {
    await db.from("user_stores").insert(
      stores.map((s) => ({ user_id: created.user.id, store_id: s }))
    );
  }

  console.log(`  made  ${email}  ${role}${store_id ? " @ " + store_id : ""}`);
  made++;
}

// Scope for accounts that already existed before this run.
for (const [email, stores] of Object.entries(SCOPE)) {
  const { data: p } = await db.from("profiles").select("id").eq("email", email).single();
  if (!p) continue;
  await db.from("user_stores").delete().eq("user_id", p.id);
  await db.from("user_stores").insert(
    stores.map((s) => ({ user_id: p.id, store_id: s }))
  );
}

console.log(`\n${made} created, ${skipped} already there`);
console.log("Permissions come from each role's defaults — open a user in Admin to change them.");
