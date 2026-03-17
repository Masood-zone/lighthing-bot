import { useMutation } from "@tanstack/react-query";
import { startSession, stopSession } from "./session-api";

export const useSessionQueries = () => {
  const startSessionMutation = useMutation({
    mutationFn: (sessionId: string) => startSession(sessionId),
  });

  const stopSessionMutation = useMutation({
    mutationFn: (sessionId: string) => stopSession(sessionId),
  });

  return {
    startSessionMutation,
    stopSessionMutation,
  };
};
