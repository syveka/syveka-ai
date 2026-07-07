import { Plus, Pin } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Item = { id: string; title: string; isPinned: boolean };

export async function ConversationList({
  conversations,
  activeId,
}: {
  conversations: Item[];
  activeId?: string;
}) {
  const t = await getTranslations("chat");
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e md:flex">
      <div className="p-3">
        <Button variant="outline" className="w-full justify-start gap-2" asChild>
          <Link href="/chat">
            <Plus className="size-4" />
            {t("newConversation")}
          </Link>
        </Button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {conversations.map((c) => (
          <Link
            key={c.id}
            href={`/chat/${c.id}`}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
              c.id === activeId
                ? "bg-accent font-medium"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {c.isPinned ? <Pin className="size-3 shrink-0" /> : null}
            <span className="truncate">{c.title}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
