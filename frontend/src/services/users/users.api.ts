import { apiClient } from "../api/root";
import type { BotUser, CreateUserInput, UpdateUserInput } from "./users.types";

export async function listUsers(): Promise<BotUser[]> {
  const response = await apiClient.get("/users");
  return response.data as BotUser[];
}

export async function createUser(input: CreateUserInput): Promise<BotUser> {
  const response = await apiClient.post("/users", input);
  const data = response.data as { id: string; user: BotUser };
  return data.user;
}

export async function updateUser(
  userId: string,
  patch: UpdateUserInput,
): Promise<BotUser> {
  const response = await apiClient.put(`/users/${userId}`, patch);
  const data = response.data as { ok: true; user: BotUser };
  return data.user;
}

export async function deleteUser(
  userId: string,
): Promise<{ ok: true; deleted: boolean }> {
  const response = await apiClient.delete(`/users/${userId}`);
  return response.data as { ok: true; deleted: boolean };
}
