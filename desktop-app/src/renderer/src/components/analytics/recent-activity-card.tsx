import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function RecentActivityCard({
  recentCompleted,
  recentErrors,
}: {
  recentCompleted: unknown[];
  recentErrors: unknown[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>Latest completed sessions and errors</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium">
            Recent completed ({recentCompleted.length})
          </div>
          <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 text-xs">
            {safeJson(recentCompleted.slice(0, 10))}
          </pre>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">
            Recent errors ({recentErrors.length})
          </div>
          <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md border p-3 text-xs">
            {safeJson(recentErrors.slice(0, 10))}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
