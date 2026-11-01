import { Pin } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { cn } from "@/lib/utils";

type Item = { id: string; title: string; isPinned: boolean };

/**
 * Earlier conversations (desktop). "New conversation" lives in the chat view
 * itself, on every screen size, so a new chat also resets an unsaved one.
 */
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
      <nav
        aria-label={t("conversations")}
        className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4 pt-3"
      >
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
            <span dir="auto" className="truncate">
              {c.title}
            </span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
