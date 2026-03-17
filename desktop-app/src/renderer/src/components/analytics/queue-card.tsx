import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { QueueAnalytics } from "@/services/analytics/analytics-api";

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function QueueCard({ queue }: { queue: QueueAnalytics }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queue</CardTitle>
        <CardDescription>Current queue state and concurrency</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">
            Max concurrent: {queue.maxConcurrent}
          </Badge>
          <Badge variant="secondary">Active: {queue.activeCount}</Badge>
          <Badge variant="secondary">Queued: {queue.queuedCount}</Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-medium">Active sessions</div>
            <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-3 text-xs">
              {safeJson(
                queue.activeSessions?.slice?.(0, 10) ?? queue.activeSessions,
              )}
            </pre>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">Queued sessions</div>
            <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-3 text-xs">
              {safeJson(
                queue.queuedSessions?.slice?.(0, 10) ?? queue.queuedSessions,
              )}
            </pre>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
