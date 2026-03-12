import { apiClient } from "../api/root";

export const loginApi = async (data: { email: string; password: string }) => {
  const response = await apiClient.post("/auth/login", data);
  return response.data as AuthenticatedUser;
};
