import { useMutation, useQueryClient } from "@tanstack/react-query";
import { startSession, stopSession } from "./session-api";
import { usersKeys } from "../users/users.keys";

export const useSessionQueries = () => {
  const queryClient = useQueryClient();

  const startSessionMutation = useMutation({
    mutationFn: (sessionId: string) => startSession(sessionId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: usersKeys.list() });
    },
  });

  const stopSessionMutation = useMutation({
    mutationFn: (sessionId: string) => stopSession(sessionId),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: usersKeys.list() });
    },
  });

  return {
    startSessionMutation,
    stopSessionMutation,
  };
};
