import { apiClient } from "../api/root";

export type StartSessionResponse = {
  ok: true;
  queued: true;
  id: string;
};

export type StopSessionResponse = {
  ok: true;
  stopped: true;
  wasRunning: boolean;
};

export async function startSession(sessionId: string) {
  const response = await apiClient.post(`/sessions/${sessionId}/start`);
  return response.data as StartSessionResponse;
}

export async function stopSession(sessionId: string) {
  const response = await apiClient.post(`/sessions/${sessionId}/stop`);
  return response.data as StopSessionResponse;
}
