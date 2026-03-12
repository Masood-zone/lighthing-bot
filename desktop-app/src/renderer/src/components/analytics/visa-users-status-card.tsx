import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { VisaUsersAnalytics } from "@/services/analytics/analytics-api";

export function VisaUsersStatusCard({
  visaUsers,
}: {
  visaUsers: VisaUsersAnalytics;
}) {
  const entries = Object.entries(visaUsers.byStatus || {}).sort(
    (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Visa Users by Status</CardTitle>
        <CardDescription>
          Breakdown of users across lifecycle statuses
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="text-muted-foreground text-sm">
            No status data available.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entries.map(([status, count]) => (
              <Badge key={status} variant="secondary" className="gap-2">
                <span className="font-medium">{status}</span>
                <span className="tabular-nums">
                  {(count ?? 0).toLocaleString()}
                </span>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
