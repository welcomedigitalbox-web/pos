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

const APPROVER_ROLES = ["sale_manager", "owner", "admin"];

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

    // Confirm the caller (the cashier's own browser session) is a real logged-in user.
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

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json();
    const { email, password, pin } = body;

    // ---- Method 1: Quick PIN approval ----
    if (pin) {
      const { data: matches, error: pinErr } = await adminClient
        .from("profiles")
        .select("id, email, role")
        .eq("approval_pin", pin)
        .in("role", APPROVER_ROLES);

      if (pinErr || !matches || matches.length === 0) {
        return new Response(JSON.stringify({ error: "Invalid PIN" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const approver = matches[0];
      return new Response(
        JSON.stringify({ approved: true, approver_email: approver.email, approver_role: approver.role }),
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
