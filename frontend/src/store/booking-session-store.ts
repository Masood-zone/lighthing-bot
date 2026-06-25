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
  syncActiveUsers: (users: BotUser[]) => void;
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
      syncActiveUsers: (users) => {
        set((state) => {
          const sessionById = new Map(
            state.sessions.map((session) => [session.id, session]),
          );

          for (const user of users) {
            if (user.status !== "QUEUED" && user.status !== "RUNNING") continue;

            const existing = sessionById.get(user.id);
            sessionById.set(user.id, {
              id: user.id,
              user,
              status: "queued",
              lastEvent: existing?.lastEvent || getActiveUserLastEvent(user),
              lastResponse: existing?.lastResponse,
            });
          }

          return { sessions: Array.from(sessionById.values()) };
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
