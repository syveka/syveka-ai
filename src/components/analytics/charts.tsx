import { cn } from "@/lib/utils";

/** Dependency-free SVG bar chart (RSC-rendered; charts lib arrives with recharts in Phase 3). */
export function BarChart({
  data,
  height = 120,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">—</p>;
  }
  return (
    <div className="flex items-end gap-1" style={{ height }} role="img" aria-label="bar chart">
      {data.map((d) => (
        <div key={d.label} className="group relative flex-1">
          <div
            className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
            style={{ height: `${Math.max(2, (d.value / max) * (height - 20))}px` }}
          />
          <span className="pointer-events-none absolute -top-5 start-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-xs shadow group-hover:block">
            {d.label}: {d.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FunnelChart({
  data,
  formatValue,
}: {
  data: Array<{ stage: string; count: number; value: string; isWon?: boolean; isLost?: boolean }>;
  formatValue?: never;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.stage}>
          <div className="mb-0.5 flex justify-between text-sm">
            <span>{d.stage}</span>
            <span className="text-muted-foreground">
              {d.count} · {d.value}
            </span>
          </div>
          <div className="h-3 overflow-hidden rounded bg-muted">
            <div
              className={cn(
                "h-full rounded",
                d.isWon ? "bg-success" : d.isLost ? "bg-destructive/60" : "bg-primary/70",
              )}
              style={{ width: `${(d.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
