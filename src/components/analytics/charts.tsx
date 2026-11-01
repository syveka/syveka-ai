import { cn } from "@/lib/utils";

/** Few enough bars that each one can carry its own visible date and value. */
const LABEL_EVERY_BAR_MAX = 7;

/**
 * Dependency-free bar chart (RSC-rendered). The picture is decorative for
 * assistive technology; the same numbers are always available as text:
 * values above the bars and dates below them when there are few bars (first
 * and last date otherwise), a visible one-line summary, and a visually hidden
 * table with every date and value. Bars have a maximum width, so a single day
 * of data is one bar, not a block across the whole card. An empty series shows
 * `emptyLabel`, never a bare dash.
 */
export function BarChart({
  data,
  title,
  summary,
  emptyLabel,
  dateHeader,
  valueHeader,
  height = 120,
}: {
  /** `label` is the already-localized date; `valueText` the localized number. */
  data: Array<{ key: string; label: string; value: number; valueText: string }>;
  title: string;
  summary: string;
  emptyLabel: string;
  dateHeader: string;
  valueHeader: string;
  height?: number;
}) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  const labelEveryBar = data.length <= LABEL_EVERY_BAR_MAX;
  return (
    <figure className="space-y-1">
      <div className="flex items-end justify-center gap-1" style={{ height }} aria-hidden="true">
        {data.map((d) => (
          <div
            key={d.key}
            className="group relative flex h-full max-w-12 flex-1 flex-col items-center justify-end"
          >
            {labelEveryBar ? (
              <span className="mb-0.5 text-xs tabular-nums text-muted-foreground">
                {d.valueText}
              </span>
            ) : null}
            <div
              className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
              style={{ height: `${Math.max(2, (d.value / max) * (height - 20))}px` }}
            />
            <span className="pointer-events-none absolute -top-5 start-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-xs shadow group-hover:block">
              {d.label}: {d.valueText}
            </span>
          </div>
        ))}
      </div>
      <div
        className={cn(
          "flex gap-1 text-xs text-muted-foreground",
          labelEveryBar ? "justify-center" : "justify-between",
        )}
        aria-hidden="true"
      >
        {labelEveryBar ? (
          data.map((d) => (
            <span key={d.key} className="max-w-12 flex-1 truncate text-center">
              {d.label}
            </span>
          ))
        ) : (
          <>
            <span>{data[0]!.label}</span>
            <span>{data[data.length - 1]!.label}</span>
          </>
        )}
      </div>
      <figcaption className="text-xs text-muted-foreground">{summary}</figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{dateHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              <td>{d.valueText}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function FunnelChart({
  data,
}: {
  data: Array<{ stage: string; count: number; value: string; isWon?: boolean; isLost?: boolean }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.stage}>
          <div className="mb-0.5 flex justify-between gap-3 text-sm">
            <span className="min-w-0 break-words">{d.stage}</span>
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">
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
