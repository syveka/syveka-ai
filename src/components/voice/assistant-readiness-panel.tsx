import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type ReadinessPanelText = {
  title: string;
  summary: string;
  items: Array<{ key: string; title: string; action: string }>;
  noticeLabel: string;
  notice: string | null;
  noticeLanguage: string;
  noticeStatus: string;
  noticeApproved: boolean;
};

/** Plain text from the server: nothing here needs the browser, and no configuration reaches it. */
export function AssistantReadinessPanel({ text }: { text: ReadinessPanelText }) {
  return (
    <Card role="region" aria-labelledby="voice-readiness-title">
      <CardHeader>
        <CardTitle id="voice-readiness-title" role="heading" aria-level={2} className="text-base">
          {text.title}
        </CardTitle>
        <CardDescription>{text.summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {text.items.length > 0 ? (
          <ul className="space-y-3">
            {text.items.map((item) => (
              <li key={item.key} className="rounded-md border p-3 text-start">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{item.action}</p>
              </li>
            ))}
          </ul>
        ) : null}
        {text.notice ? (
          <div className="rounded-md bg-muted p-3 text-start">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{text.noticeLabel}</p>
              <span
                className={
                  text.noticeApproved
                    ? "rounded-full border px-2 py-0.5 text-xs"
                    : "rounded-full border border-warning px-2 py-0.5 text-xs"
                }
              >
                {text.noticeStatus}
              </span>
            </div>
            {/* The assistant's language can differ from the page's, so it sets its own direction. */}
            <p dir="auto" lang={text.noticeLanguage} className="mt-2 break-words text-sm">
              {text.notice}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
