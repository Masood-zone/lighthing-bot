import { IconDeviceDesktop, IconMail, IconPencil } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

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
import { Checkbox } from "@/components/ui/checkbox";
import {
  useDesktopNotificationsQuery,
  useNotificationsQuery,
  useSaveDesktopNotificationsEnabled,
} from "@/services/notifications/notifications-queries";
import { NotificationEmailModal } from "@/components/sidebar/notification-email-modal";

export function NotificationEmailCard() {
  const { data: recipient, isLoading } = useNotificationsQuery();
  const { data: desktopEnabled, isLoading: isDesktopLoading } =
    useDesktopNotificationsQuery();
  const saveDesktopEnabled = useSaveDesktopNotificationsEnabled();
  const [open, setOpen] = useState(false);

  const setDesktopNotifications = async (checked: boolean | "indeterminate") => {
    const enabled = checked === true;
    try {
      await saveDesktopEnabled.mutateAsync(enabled);
      toast.success(enabled ? "Desktop booking alerts enabled" : "Desktop booking alerts disabled");
    } catch {
      toast.error("Could not update desktop booking alerts");
    }
  };

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
          <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <IconDeviceDesktop className="size-4" />
                Desktop booking alerts
              </div>
              <p className="text-sm text-muted-foreground">
                Show a Windows notification on this backend computer only after a confirmed booking.
              </p>
            </div>
            <Checkbox
              aria-label="Enable desktop booking alerts"
              checked={desktopEnabled === true}
              disabled={isDesktopLoading || saveDesktopEnabled.isPending}
              onCheckedChange={setDesktopNotifications}
            />
          </div>
        </CardContent>
      </Card>

      <NotificationEmailModal open={open} onOpenChange={setOpen} />
    </>
  );
}
