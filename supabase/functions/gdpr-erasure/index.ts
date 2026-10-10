// Supabase Edge Function (Deno): hard-deletes an organization after the
// 30-day grace period (§13.3 GDPR erasure). Invoked by platform ops or the
// self-serve deletion flow with the service-role key. The decision logic
// lives in erasure.ts (tested in
// tests/unit/gdpr-erasure.test.ts); this file only wires it to Supabase.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { eraseOrganization } from "./erasure.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) {
    return json({ error: "unauthorized" }, 401);
  }

  const { orgId } = await req.json().catch(() => ({}));
  if (!orgId) return json({ error: "orgId required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const result = await eraseOrganization(
    {
      findDeletedAt: async (id) => {
        const { data } = await supabase
          .from("organizations")
          .select("deleted_at")
          .eq("id", id)
          .maybeSingle();
        return (data?.deleted_at as string | null | undefined) ?? null;
      },
      bucket: (name) => supabase.storage.from(name),
      // Hard delete — FK cascades remove all tenant rows (§5.1)
      deleteOrganization: async (id) => {
        const { error } = await supabase.from("organizations").delete().eq("id", id);
        return { error };
      },
    },
    orgId,
  );
  return json(result.body, result.status);
});
