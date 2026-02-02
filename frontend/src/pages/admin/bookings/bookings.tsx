import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { getApiErrorMessage } from "@/services/api/errors";
import { useSessionQueries } from "@/services/session/session-queries";
import { useUsersQuery } from "@/services/users/use-users";
import type { BotUser } from "@/services/users/users.types";

type UiSessionStatus = "idle" | "queued" | "stopped";

type UiSession = {
  id: string;
  user: BotUser;
  status: UiSessionStatus;
  lastEvent?: string;
  lastResponse?: unknown;
};

function statusBadge(status: UiSessionStatus) {
  if (status === "queued") return <Badge>Started</Badge>;
  if (status === "stopped") return <Badge variant="secondary">Stopped</Badge>;
  return <Badge variant="outline">Idle</Badge>;
}

function BookingsPage() {
  const {
    data: usersQuery,
    isPending,
    isError,
    error,
    refetch,
  } = useUsersQuery();
  const { startSessionMutation, stopSessionMutation } = useSessionQueries();

  const users = usersQuery;
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>();
  const [sessions, setSessions] = useState<UiSession[]>([]);
  const [pendingById, setPendingById] = useState<
    Record<string, "starting" | "stopping" | undefined>
  >({});

  const selectedUser = useMemo(
    () => users?.find((u) => u.id === selectedUserId) ?? null,
    [users, selectedUserId],
  );

  const addOrUpdateSession = (
    sessionId: string,
    updater: (prev: UiSession) => UiSession,
    fallbackUser?: BotUser,
  ) => {
    setSessions((prev) => {
      const existingIndex = prev.findIndex((s) => s.id === sessionId);
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = updater(next[existingIndex]);
        return next;
      }

      if (!fallbackUser) return prev;
      const created: UiSession = {
        id: sessionId,
        user: fallbackUser,
        status: "idle",
      };
      return [...prev, updater(created)];
    });
  };

  const startOne = async (user: BotUser) => {
    const sessionId = user.id;
    setPendingById((m) => ({ ...m, [sessionId]: "starting" }));

    try {
      const data = await startSessionMutation.mutateAsync(sessionId);

      addOrUpdateSession(
        sessionId,
        (prev) => ({
          ...prev,
          status: "queued",
          lastEvent: `Started (queued) at ${new Date().toLocaleTimeString()}`,
          lastResponse: data,
        }),
        user,
      );

      toast.success("Session started", {
        description: `Queued user ${user.config?.email || user.id}`,
      });
    } catch (error) {
      toast.error("Failed to start session", {
        description: getApiErrorMessage(error),
      });
    } finally {
      setPendingById((m) => ({ ...m, [sessionId]: undefined }));
    }
  };

  const startSelected = async () => {
    if (!selectedUser) return;
    await startOne(selectedUser);
  };

  const stopOne = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    setPendingById((m) => ({ ...m, [sessionId]: "stopping" }));

    try {
      const data = await stopSessionMutation.mutateAsync(sessionId);

      addOrUpdateSession(sessionId, (prev) => ({
        ...prev,
        status: "stopped",
        lastEvent: `Stopped at ${new Date().toLocaleTimeString()} (wasRunning=${String(
          data.wasRunning,
        )})`,
        lastResponse: data,
      }));

      toast.success("Session stopped", {
        description: session.user.config?.email || session.user.id,
      });
    } catch (error) {
      toast.error("Failed to stop session", {
        description: getApiErrorMessage(error),
      });
    } finally {
      setPendingById((m) => ({ ...m, [sessionId]: undefined }));
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <p className="text-sm text-muted-foreground">
          Start and manage concurrent booking appointment hunting sessions per
          user.
        </p>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-xl">Start a session</CardTitle>
          <CardDescription>
            Select a user, then click “Start booking hunt” to start their
            session.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : isError ? (
            <div className="rounded-md border p-4 text-sm">
              <div className="font-medium">Failed to load users</div>
              <div className="mt-1 text-muted-foreground">
                {getApiErrorMessage(error)}
              </div>
              <div className="mt-3">
                <Button
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : users?.length === 0 ? (
            <div className="rounded-md border p-6 text-center">
              <div className="text-sm font-medium">No users found</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Create at least one user before starting sessions.
              </div>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-2">
                <div className="text-sm font-medium">User</div>
                <Select
                  value={selectedUserId}
                  onValueChange={(v) => setSelectedUserId(v)}
                >
                  <SelectTrigger
                    className="w-full cursor-pointer"
                    size="default"
                  >
                    <SelectValue placeholder="Select a user…" />
                  </SelectTrigger>
                  <SelectContent>
                    {users?.map((u) => (
                      <SelectItem
                        key={u.id}
                        value={u.id}
                        className="cursor-pointer"
                      >
                        <div className="flex w-full items-center justify-between gap-3">
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {u.config?.displayName || "(No name)"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {u.config?.email || u.id}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {u.id.slice(0, 8)}…
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2">
                {selectedUser ? (
                  <Button
                    size="lg"
                    className="cursor-pointer"
                    onClick={startSelected}
                    disabled={pendingById[selectedUser.id] === "starting"}
                  >
                    {pendingById[selectedUser.id] === "starting"
                      ? "Starting…"
                      : "Start booking hunt"}
                  </Button>
                ) : (
                  <Button size="lg" disabled>
                    Start booking hunt
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
        {selectedUser ? (
          <CardFooter className="border-t justify-between">
            <div className="text-sm text-muted-foreground">
              Selected:{" "}
              <span className="font-medium text-foreground">
                {selectedUser.config?.email || selectedUser.id}
              </span>
            </div>
          </CardFooter>
        ) : null}
      </Card>

      <div className="grid gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sessions</h2>
          <div className="text-sm text-muted-foreground">
            {sessions.length} tracked
          </div>
        </div>

        {sessions.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No sessions yet</CardTitle>
              <CardDescription>
                Start a booking hunt to create a session card here.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {sessions.map((s) => (
              <Card key={s.id} className="overflow-hidden">
                <CardHeader className="border-b">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <CardTitle className="text-lg">
                        {s.user.config?.displayName || "Booking session"}
                      </CardTitle>
                      <CardDescription>
                        {s.user.config?.email || s.user.id}
                      </CardDescription>
                    </div>
                    {statusBadge(s.status)}
                  </div>
                </CardHeader>

                <CardContent className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Session id
                      </div>
                      <div className="text-sm font-mono">{s.id}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Last event
                      </div>
                      <div className="text-sm">
                        {s.lastEvent ? s.lastEvent : "—"}
                      </div>
                    </div>
                  </div>

                  {s.status !== "idle" && s.lastResponse ? (
                    <div className="rounded-md border bg-muted/20 p-3">
                      <div className="text-xs text-muted-foreground">
                        Last response
                      </div>
                      <pre className="mt-2 max-h-40 overflow-auto text-xs">
                        {JSON.stringify(s.lastResponse, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </CardContent>

                <CardFooter className="border-t justify-end gap-2">
                  {s.status === "queued" ? (
                    <Button
                      variant="destructive"
                      size="lg"
                      className="cursor-pointer"
                      onClick={() => stopOne(s.id)}
                      disabled={pendingById[s.id] !== undefined}
                    >
                      {pendingById[s.id] === "stopping" ? "Stopping…" : "Stop"}
                    </Button>
                  ) : (
                    <Button
                      size="lg"
                      className="cursor-pointer"
                      onClick={() => startOne(s.user)}
                      disabled={pendingById[s.id] !== undefined}
                    >
                      {pendingById[s.id] === "starting" ? "Starting…" : "Start"}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default BookingsPage;
