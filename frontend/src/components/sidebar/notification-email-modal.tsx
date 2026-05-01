import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiErrorMessage } from "@/services/api/errors";
import {
  useNotificationsQuery,
  useSaveNotificationRecipient,
} from "@/services/notifications/notifications-queries";

type NotificationEmailModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function NotificationEmailModal({
  open,
  onOpenChange,
}: NotificationEmailModalProps) {
  const { data: recipient, isLoading } = useNotificationsQuery();
  const saveRecipient = useSaveNotificationRecipient();
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (open) {
      setEmail(recipient?.email || "");
    }
  }, [open, recipient]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextEmail = email.trim();
    if (!nextEmail) {
      toast.error("Notification email is required");
      return;
    }

    try {
      await saveRecipient.mutateAsync({ email: nextEmail, active: true });
      toast.success("Notification email saved", {
        description:
          "Future booking success emails will go to this address only.",
      });
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to save notification email", {
        description: getApiErrorMessage(error),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Notification email</DialogTitle>
          <DialogDescription>
            Set the single email address that receives booking success alerts.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="notification-email">Email address</Label>
            <Input
              id="notification-email"
              type="email"
              placeholder="admin@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isLoading || saveRecipient.isPending}
              required
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saveRecipient.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveRecipient.isPending}>
              {saveRecipient.isPending ? "Saving…" : "Save email"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
