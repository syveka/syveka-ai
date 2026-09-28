import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCount } from "./plan-display";

type Meter = { label: string; used: number; limit: number };

export function UsageMeters({ items, locale }: { items: Meter[]; locale: string }) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {items.map((m) => {
          const unlimited = m.limit >= Number.MAX_SAFE_INTEGER;
          const pct = unlimited
            ? 0
            : Math.min(100, Math.round((m.used / Math.max(1, m.limit)) * 100));
          return (
            <div key={m.label}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{m.label}</span>
                <span className="text-muted-foreground">
                  {formatCount(locale, m.used)} / {unlimited ? "∞" : formatCount(locale, m.limit)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary",
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
