import { apiClient } from "../api/root";

export const registerUser = async (data: BasicUser) => {
  const response = await apiClient.post("/users", data);
  return response.data as BasicUser;
};

export const getUsers = async () => {
  const response = await apiClient.get("/users");
  return response.data as BasicUser[];
};

export const updateUser = async (userId: string, data: Partial<BasicUser>) => {
  const response = await apiClient.put(`/users/${userId}`, data);
  return response.data as BasicUser;
};

export const getUserById = async (userId: string) => {
  const response = await apiClient.get(`/users/${userId}`);
  return response.data as BasicUser;
};

export const deleteUser = async (userId: string) => {
  const response = await apiClient.delete(`/users/${userId}`);
  return response.data as { success: boolean };
};
