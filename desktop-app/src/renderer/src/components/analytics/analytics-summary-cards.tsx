import {
  IconAlertTriangle,
  IconShieldLock,
  IconUsers,
  IconUserScan,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AnalyticsResponse } from "@/services/analytics/analytics-api";

function formatTimestamp(ts?: string) {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

export function AnalyticsSummaryCards({
  analytics,
}: {
  analytics: AnalyticsResponse;
}) {
  const byStatusEntries = Object.entries(analytics.visaUsers.byStatus || {});
  const topStatus = byStatusEntries.sort(
    (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
  )[0];

  return (
    <div className="*:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Admins</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {analytics.admins.count.toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge variant="outline" className="gap-1">
              <IconShieldLock className="size-4" />
              ADMIN
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {analytics.admins.items[0]?.email
              ? `Latest: ${analytics.admins.items[0].email}`
              : "No admin records"}
          </div>
          <div className="text-muted-foreground">
            Updated {formatTimestamp(analytics.ts)}
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Visa Users</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {analytics.visaUsers.count.toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge variant="outline" className="gap-1">
              <IconUsers className="size-4" />
              Total
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {topStatus
              ? `Top status: ${topStatus[0]} (${(topStatus[1] ?? 0).toLocaleString()})`
              : "No status breakdown"}
          </div>
          <div className="text-muted-foreground">
            Updated {formatTimestamp(analytics.ts)}
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Queue</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {analytics.queue.activeCount.toLocaleString()} active
          </CardTitle>
          <CardAction>
            <Badge variant="outline" className="gap-1">
              <IconUserScan className="size-4" />
              {analytics.queue.queuedCount.toLocaleString()} queued
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Max concurrent: {analytics.queue.maxConcurrent.toLocaleString()}
          </div>
          <div className="text-muted-foreground">
            Updated {formatTimestamp(analytics.queue.ts)}
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Issues</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {(analytics.issues.recentErrors?.length ?? 0).toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge variant="outline" className="gap-1">
              <IconAlertTriangle className="size-4" />
              recent errors
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Recent completed:{" "}
            {(analytics.success.recentCompleted?.length ?? 0).toLocaleString()}
          </div>
          <div className="text-muted-foreground">
            Updated {formatTimestamp(analytics.ts)}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
