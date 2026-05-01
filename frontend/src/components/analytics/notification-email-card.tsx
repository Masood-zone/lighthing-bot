import { IconMail, IconPencil } from "@tabler/icons-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useNotificationsQuery } from "@/services/notifications/notifications-queries";
import { NotificationEmailModal } from "@/components/sidebar/notification-email-modal";

export function NotificationEmailCard() {
  const { data: recipient, isLoading } = useNotificationsQuery();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Notification Email</CardTitle>
          <CardDescription>
            Single destination for final booking success alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <IconMail className="size-4" />
                {recipient?.email || "No notification email configured"}
              </div>
              <div className="flex items-center justify-between gap-3">
                <Badge variant={recipient?.email ? "secondary" : "outline"}>
                  {recipient?.email ? "Active" : "Not set"}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => setOpen(true)}
                >
                  <IconPencil />
                  {recipient?.email ? "Edit" : "Add email"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <NotificationEmailModal open={open} onOpenChange={setOpen} />
    </>
  );
}
