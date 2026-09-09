import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { BotUser } from "@/services/users/users.types";

export type UiSessionStatus = "idle" | "queued" | "stopped";

export type UiSession = {
  id: string;
  user: BotUser;
  status: UiSessionStatus;
  lastEvent?: string;
  lastResponse?: unknown;
};

type BookingSessionStore = {
  selectedUserId?: string;
  sessions: UiSession[];
  setSelectedUserId: (selectedUserId?: string) => void;
  addOrUpdateSession: (
    sessionId: string,
    updater: (prev: UiSession) => UiSession,
    fallbackUser?: BotUser,
  ) => void;
  removeSession: (sessionId: string) => void;
  reconcileUsers: (users: BotUser[]) => void;
};

function getActiveUserLastEvent(user: BotUser) {
  if (user.queue.startedAt) {
    return `Running since ${new Date(user.queue.startedAt).toLocaleTimeString()}`;
  }

  if (user.queue.enqueuedAt) {
    return `Queued since ${new Date(user.queue.enqueuedAt).toLocaleTimeString()}`;
  }

  return user.lastMessage || `Active (${user.status})`;
}

export const useBookingSessionStore = create<BookingSessionStore>()(
  persist(
    (set) => ({
      selectedUserId: undefined,
      sessions: [],
      setSelectedUserId: (selectedUserId) => set({ selectedUserId }),
      addOrUpdateSession: (sessionId, updater, fallbackUser) => {
        set((state) => {
          const existingIndex = state.sessions.findIndex(
            (session) => session.id === sessionId,
          );

          if (existingIndex >= 0) {
            const sessions = [...state.sessions];
            sessions[existingIndex] = updater(sessions[existingIndex]);
            return { sessions };
          }

          if (!fallbackUser) return { sessions: state.sessions };

          const created: UiSession = {
            id: sessionId,
            user: fallbackUser,
            status: "idle",
          };

          return { sessions: [...state.sessions, updater(created)] };
        });
      },
      removeSession: (sessionId) => {
        set((state) => ({
          selectedUserId:
            state.selectedUserId === sessionId
              ? undefined
              : state.selectedUserId,
          sessions: state.sessions.filter((session) => session.id !== sessionId),
        }));
      },
      reconcileUsers: (users) => {
        set((state) => {
          const usersById = new Map(users.map((user) => [user.id, user]));
          const sessionById = new Map<string, UiSession>();

          for (const session of state.sessions) {
            const user = usersById.get(session.id);
            if (!user) continue;

            const active = user.status === "QUEUED" || user.status === "RUNNING";
            sessionById.set(session.id, {
              ...session,
              user,
              ...(active
                ? {
                    status: "queued",
                    lastEvent:
                      session.status === "queued" && session.lastEvent
                        ? session.lastEvent
                        : getActiveUserLastEvent(user),
                  }
                : {}),
            });
          }

          for (const user of users) {
            const active = user.status === "QUEUED" || user.status === "RUNNING";
            if (!active || sessionById.has(user.id)) continue;

            sessionById.set(user.id, {
              id: user.id,
              user,
              status: "queued",
              lastEvent: getActiveUserLastEvent(user),
            });
          }

          return {
            selectedUserId: usersById.has(state.selectedUserId || "")
              ? state.selectedUserId
              : undefined,
            sessions: Array.from(sessionById.values()),
          };
        });
      },
    }),
    {
      name: "booking-session-store",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        selectedUserId: state.selectedUserId,
        sessions: state.sessions,
      }),
    },
  ),
);
