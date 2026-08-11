import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <div className="h-4 w-24 animate-pulse rounded-md bg-muted" />
        <div className="h-7 w-64 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-40 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={i % 2 === 0 ? "flex justify-start" : "flex justify-end"}>
            <Card className="w-2/3">
              <CardContent className="space-y-2 p-4">
                <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
                <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted" />
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
