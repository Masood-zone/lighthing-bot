import { useAnalyticsQueries } from "@/services/analytics/analytics-queries";
import { AnalyticsSummaryCards } from "@/components/analytics/analytics-summary-cards";
import { AnalyticsDashboardSkeleton } from "@/components/analytics/analytics-dashboard-skeleton";
import { AdminsCard } from "@/components/analytics/admins-card";
import { VisaUsersStatusCard } from "@/components/analytics/visa-users-status-card";
import { QueueCard } from "@/components/analytics/queue-card";
import { RecentActivityCard } from "@/components/analytics/recent-activity-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function Dashboard() {
  const { data, isLoading, isError, error } =
    useAnalyticsQueries().analyticsQuery;

  if (isLoading) {
    return <AnalyticsDashboardSkeleton />;
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Analytics</CardTitle>
          <CardDescription>Could not load analytics data.</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          {error instanceof Error ? error.message : "Please try again."}
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Analytics</CardTitle>
          <CardDescription>No data returned.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="@container/main flex flex-1 flex-col gap-2">
        <div className="flex flex-col gap-4 md:gap-6">
          <AnalyticsSummaryCards analytics={data} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AdminsCard admins={data.admins.items} />
            <VisaUsersStatusCard visaUsers={data.visaUsers} />
            <QueueCard queue={data.queue} />
            <RecentActivityCard
              recentCompleted={data.success.recentCompleted ?? []}
              recentErrors={data.issues.recentErrors ?? []}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
