export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listDocuments } from "@/server/services/documents";
import { UploadDropzone } from "@/components/knowledge/upload-dropzone";
import { DocumentTable } from "@/components/knowledge/document-table";

export default async function KnowledgePage() {
  const ctx = await requirePermission("kb:read");
  const t = await getTranslations("knowledge");
  const documents = await listDocuments(ctx);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {can(ctx.role, "kb:write") ? <UploadDropzone /> : null}
      <DocumentTable
        documents={documents.map((d) => ({
          ...d,
          createdAt: d.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
