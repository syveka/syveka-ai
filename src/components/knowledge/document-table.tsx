"use client";

import { useRouter } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { FileText, Globe, StickyNote, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type DocumentRow = {
  id: string;
  title: string;
  sourceType: string;
  status: string;
  error: string | null;
  chunkCount: number;
  sizeBytes: number | null;
  createdAt: string;
};

const SOURCE_ICON = { UPLOAD: FileText, URL: Globe, NOTE: StickyNote } as const;

const STATUS_STYLE: Record<string, string> = {
  READY: "bg-success/15 text-success",
  PROCESSING: "bg-warning/15 text-warning animate-pulse",
  PENDING: "bg-muted text-muted-foreground",
  FAILED: "bg-destructive/15 text-destructive",
};

export function DocumentTable({ documents }: { documents: DocumentRow[] }) {
  const t = useTranslations("knowledge");
  const router = useRouter();

  const remove = async (id: string) => {
    await fetch(`/api/v1/kb/documents/${id}`, { method: "DELETE" });
    router.refresh();
  };

  if (documents.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <Card>
      <CardContent className="divide-y p-0">
        {documents.map((doc) => {
          const Icon = SOURCE_ICON[doc.sourceType as keyof typeof SOURCE_ICON] ?? FileText;
          return (
            <div key={doc.id} className="flex items-center gap-3 p-4">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{doc.title}</p>
                <p className="text-xs text-muted-foreground">
                  {doc.chunkCount > 0 ? `${doc.chunkCount} chunks · ` : ""}
                  {doc.sizeBytes ? `${(doc.sizeBytes / 1024).toFixed(0)} kB · ` : ""}
                  {new Date(doc.createdAt).toLocaleDateString()}
                </p>
                {doc.error ? <p className="text-xs text-destructive">{doc.error}</p> : null}
              </div>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  STATUS_STYLE[doc.status] ?? STATUS_STYLE.PENDING,
                )}
              >
                {t(`status.${doc.status}` as never)}
              </span>
              {doc.status === "PROCESSING" || doc.status === "PENDING" ? (
                <Button variant="ghost" size="icon" onClick={() => router.refresh()}>
                  <RefreshCw className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                onClick={() => void remove(doc.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
