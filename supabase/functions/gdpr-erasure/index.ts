// Supabase Edge Function (Deno): hard-deletes an organization after the
// 30-day grace period (§13.3 GDPR erasure). Invoked by platform ops or the
// self-serve deletion flow with the service-role key.
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const { orgId } = await req.json().catch(() => ({}));
  if (!orgId) return new Response(JSON.stringify({ error: "orgId required" }), { status: 400 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1. Verify the org was soft-deleted ≥ 30 days ago (grace period)
  const { data: org } = await supabase
    .from("organizations")
    .select("id, deleted_at, stripe_customer_id")
    .eq("id", orgId)
    .single();
  if (!org?.deleted_at) {
    return new Response(JSON.stringify({ error: "org not marked for deletion" }), { status: 409 });
  }
  const grace = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(org.deleted_at).getTime() < grace) {
    return new Response(JSON.stringify({ error: "grace period not over" }), { status: 409 });
  }

  // 2. Purge Storage objects for every org-scoped bucket
  for (const bucket of ["documents", "voice-recordings", "exports"]) {
    const { data: files } = await supabase.storage.from(bucket).list(orgId, { limit: 1000 });
    if (files?.length) {
      await supabase.storage.from(bucket).remove(files.map((f) => `${orgId}/${f.name}`));
    }
  }

  // 3. Hard delete — FK cascades remove all tenant rows (§5.1)
  await supabase.from("organizations").delete().eq("id", orgId);

  return new Response(JSON.stringify({ ok: true, purged: orgId }), {
    headers: { "content-type": "application/json" },
  });
});
