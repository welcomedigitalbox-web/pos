// @ts-nocheck
// This file runs on Deno (Supabase Edge Functions), not Next.js/Node —
// TypeScript checking is intentionally disabled here so `next build` doesn't
// try to type-check Deno-specific imports/globals.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Roles that may approve. Must match public.is_approver_role() in the
// database — that function is the source of truth for PIN approval.
const APPROVER_ROLES = ["admin", "owner", "manager"];

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // The caller's own session. Used both to confirm they are logged in and
    // to run the PIN check as them, so the lockout counter lands on their row.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData.user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const body = await req.json();
    const { email, password, pin } = body;

    // ---- Method 1: Quick PIN approval ----
    // The PIN never leaves the database boundary as plaintext-comparable
    // data: verify_approval_pin() bcrypt-compares server side, counts
    // failures against this caller, and locks out after 5 tries.
    if (pin) {
      const { data: rows, error: pinErr } = await callerClient
        .rpc("verify_approval_pin", { p_pin: pin });

      if (pinErr || !rows || rows.length === 0) {
        const msg = pinErr?.message ?? "Invalid PIN";
        // Lockout messages are worth surfacing; anything else stays generic.
        const isLockout = msg.includes("Too many failed attempts");
        return new Response(
          JSON.stringify({ error: isLockout ? msg : "Invalid PIN" }),
          { status: isLockout ? 429 : 401, headers: corsHeaders }
        );
      }

      const approver = rows[0];
      return new Response(
        JSON.stringify({
          approved: true,
          approver_email: approver.approver_email,
          approver_role: approver.approver_role,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ---- Method 2: Email + password ----
    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Missing email/password or pin" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const approverClient = createClient(supabaseUrl, anonKey);
    const { data: signInData, error: signInErr } = await approverClient.auth.signInWithPassword({
      email,
      password,
    });

    if (signInErr || !signInData.user) {
      return new Response(JSON.stringify({ error: "Incorrect email or password" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Immediately end this ephemeral server-side session — it was only used to verify the password.
    await approverClient.auth.signOut();

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", signInData.user.id)
      .single();

    if (!profile || !APPROVER_ROLES.includes(profile.role)) {
      return new Response(
        JSON.stringify({ error: "This account is not authorized to approve discounts" }),
        { status: 403, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ approved: true, approver_email: email, approver_role: profile.role }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
