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

    // Client scoped to the caller's own JWT — used only to identify who is calling
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Service-role client — required for admin actions (bypasses RLS)
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerProfile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();

    if (!callerProfile || callerProfile.role !== "admin") {
      return new Response(JSON.stringify({ error: "Only admin can create users" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const body = await req.json();
    const { email, password, role, store_id, permissions } = body;

    if (!email || !password || !role) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      return new Response(JSON.stringify({ error: createErr.message }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // profiles row is auto-created by the on_auth_user_created trigger (default role='cashier');
    // now overwrite it with the requested role/store/permissions
    const { error: updateErr } = await adminClient
      .from("profiles")
      .update({ role, store_id, permissions: permissions || [] })
      .eq("id", created.user.id);

    if (updateErr) {
      return new Response(JSON.stringify({ error: updateErr.message }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ success: true, user_id: created.user.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
