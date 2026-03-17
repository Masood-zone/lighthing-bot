import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getApiErrorMessage } from "@/services/api/errors";
import {
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useUsersQuery,
} from "@/services/users/use-users";
import type { BotUser, UpdateUserInput } from "@/services/users/users.types";
import UpsertUserDialog from "./update-user";
import DeleteUserDialog from "./delete-user";
import { getUserDisplayName, getUserEmail } from "./utils/user-utils";
import {
  CalendarClockIcon,
  CalendarRangeIcon,
  CalendarDaysIcon,
  EllipsisVerticalIcon,
} from "lucide-react";

function TimelineCell({ user }: { user: BotUser }) {
  const cfg = user.config;
  const hasAbs = Boolean(cfg?.dateStart || cfg?.dateEnd);
  const hasDays = cfg?.daysFromNowMin != null || cfg?.daysFromNowMax != null;
  const hasWeeks = cfg?.weeksFromNowMin != null || cfg?.weeksFromNowMax != null;

  if (!hasAbs && !hasDays && !hasWeeks) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Default</Badge>
        <span className="text-xs text-muted-foreground">Jan–Dec</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {hasAbs ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            <CalendarRangeIcon /> Fixed
          </Badge>
          <span className="text-xs font-medium tabular-nums">
            {(cfg?.dateStart ?? "…") + " → " + (cfg?.dateEnd ?? "…")}
          </span>
        </div>
      ) : null}

      {hasDays ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <CalendarDaysIcon /> Days
          </Badge>
          <span className="text-xs text-muted-foreground tabular-nums">
            {(cfg?.daysFromNowMin ?? "…") + "–" + (cfg?.daysFromNowMax ?? "…")}
          </span>
        </div>
      ) : null}

      {hasWeeks ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <CalendarClockIcon /> Weeks
          </Badge>
          <span className="text-xs text-muted-foreground tabular-nums">
            {(cfg?.weeksFromNowMin ?? "…") +
              "–" +
              (cfg?.weeksFromNowMax ?? "…")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export default function UsersPage() {
  const usersQuery = useUsersQuery();
  const createMutation = useCreateUser();
  const deleteMutation = useDeleteUser();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeUser, setActiveUser] = useState<BotUser | null>(null);

  const updateMutation = useUpdateUser(activeUser?.id || "");

  const createError = createMutation.error
    ? getApiErrorMessage(createMutation.error)
    : undefined;
  const editError = updateMutation.error
    ? getApiErrorMessage(updateMutation.error)
    : undefined;
  const deleteError = deleteMutation.error
    ? getApiErrorMessage(deleteMutation.error)
    : undefined;

  const rows = usersQuery.data ?? [];

  const openEdit = (u: BotUser) => {
    setActiveUser(u);
    setEditOpen(true);
  };

  const openDelete = (u: BotUser) => {
    setActiveUser(u);
    setDeleteOpen(true);
  };

  const closeAll = () => {
    setCreateOpen(false);
    setEditOpen(false);
    setDeleteOpen(false);
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Manage booking-hunt users and their configuration.
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="cursor-pointer"
          disabled={createMutation.isPending}
        >
          Create User
        </Button>
      </div>

      {usersQuery.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : usersQuery.isError ? (
        <div className="rounded-md border p-4 text-sm">
          <div className="font-medium">Failed to load users</div>
          <div className="text-muted-foreground mt-1">
            {getApiErrorMessage(usersQuery.error)}
          </div>
          <div className="mt-3">
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => usersQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border p-6 text-center">
          <div className="text-sm font-medium">No users yet</div>
          <div className="text-muted-foreground mt-1 text-sm">
            Create your first user to start booking-hunt automation.
          </div>
          <div className="mt-4">
            <Button
              className="cursor-pointer"
              onClick={() => setCreateOpen(true)}
            >
              Create User
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Timeline</TableHead>
                <TableHead>Reschedule</TableHead>
                {/* <TableHead>Status</TableHead> */}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u: BotUser) => (
                <TableRow key={u.id}>
                  <TableCell>{getUserEmail(u)}</TableCell>
                  <TableCell>{getUserDisplayName(u)}</TableCell>
                  <TableCell>
                    <TimelineCell user={u} />
                  </TableCell>
                  <TableCell>
                    {u.config?.reschedule ? (
                      <Badge variant="secondary">Yes</Badge>
                    ) : (
                      <Badge variant="outline">No</Badge>
                    )}
                  </TableCell>
                  {/* <TableCell>{statusBadge(u.status)}</TableCell> */}
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="cursor-pointer"
                        >
                          <EllipsisVerticalIcon className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onSelect={() => openEdit(u)}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer"
                          variant="destructive"
                          onSelect={() => openDelete(u)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <UpsertUserDialog
        open={createOpen}
        onOpenChange={(o) => {
          if (!o) closeAll();
          else setCreateOpen(true);
        }}
        mode="create"
        onCreate={async (values) => {
          await createMutation.mutateAsync(values);
          toast.success("User created");
          closeAll();
        }}
        onEdit={async () => {
          // not used
        }}
        pending={createMutation.isPending}
        errorMessage={createError}
      />

      <UpsertUserDialog
        open={editOpen}
        onOpenChange={(o) => {
          if (!o) closeAll();
          else setEditOpen(true);
        }}
        mode="edit"
        initial={activeUser}
        onCreate={async () => {
          // not used
        }}
        onEdit={async (values) => {
          if (!activeUser?.id) return;

          const patch: UpdateUserInput = { ...values };
          if (!patch.password) delete patch.password;
          await updateMutation.mutateAsync(patch);

          toast.success("User updated");
          closeAll();
        }}
        pending={updateMutation.isPending}
        errorMessage={editError}
      />

      <DeleteUserDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          if (!o) closeAll();
          else setDeleteOpen(true);
        }}
        user={activeUser}
        pending={deleteMutation.isPending}
        errorMessage={deleteError}
        onConfirm={async () => {
          if (!activeUser?.id) return;
          await deleteMutation.mutateAsync(activeUser.id);
          toast.success("User deleted");
          closeAll();
        }}
      />
    </div>
  );
}
