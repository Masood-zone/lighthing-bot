import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BotUser } from "@/services/users/users.types";
import { getUserEmail } from "./utils/user-utils";

export default function DeleteUserDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user?: BotUser | null;
  onConfirm: () => Promise<void>;
  pending: boolean;
  errorMessage?: string;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o: boolean) => !props.pending && props.onOpenChange(o)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete User</DialogTitle>
          <DialogDescription>
            This will permanently delete the user and stop any running booking
            hunt.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 text-sm">
          <div className="text-muted-foreground">User</div>
          <div className="font-medium">
            {props.user ? getUserEmail(props.user) : ""}
          </div>
        </div>

        {props.errorMessage ? (
          <div className="mt-4 text-sm text-destructive">
            {props.errorMessage}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={props.pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => props.onConfirm()}
            disabled={props.pending}
          >
            {props.pending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
