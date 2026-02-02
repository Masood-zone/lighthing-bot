import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { loginApi } from "../auth/auth";
import { useUserStore } from "@/store/user-store";
import axios from "axios";
import {
  deleteUser,
  getUserById,
  getUsers,
  registerUser,
  updateUser,
} from "./user-queries";

export const useLogin = () => {
  const { setUser } = useUserStore();
  return useMutation({
    mutationFn: loginApi,
    onSuccess: (auth: AuthenticatedUser) => {
      setUser(auth);
      toast.success("Logged in successfully!");
    },
    onError: (error) => {
      const code =
        axios.isAxiosError(error) && error.response?.data
          ? (error.response.data as { error?: string }).error
          : undefined;

      if (code === "invalid_credentials") {
        toast.error("Invalid credentials", {
          description: "Email or password is incorrect.",
        });
        return;
      }

      toast.error("Oops! Error", {
        description: "There was an error logging in!",
      });
    },
  });
};

export const useLogout = () => {
  const { logout } = useUserStore();
  return useMutation({
    mutationFn: async () => {
      logout();
    },
    onSuccess: () => {
      toast.success("Logged out successfully!");
    },
    onError: (error) => {
      console.log(error);
      toast.error("Oops! Error", {
        description: "There was error logging out!",
      });
    },
  });
};

export const useRegisterUser = () => {
  return useMutation({
    mutationFn: registerUser,
    onSuccess: () => {
      toast.success("User registered successfully!");
    },
    onError: (error) => {
      console.log(error);
      toast.error("Oops! Error", {
        description: "There was an error registering the user!",
      });
    },
  });
};

export const useGetUsers = () => {
  return useMutation({
    mutationFn: getUsers,
    onError: (error) => {
      console.log(error);
      toast.error("Oops! Error", {
        description: "There was an error fetching users!",
      });
    },
  });
};

export const useGetUserById = (userId: string) => {
  return useMutation({
    mutationFn: getUserById.bind(null, userId),
    onError: (error) => {
      console.log(error);
      toast.error("Oops! Error", {
        description: "There was an error fetching the user!",
      });
    },
  });
};

export const useUpdateUser = (userId: string) => {
  return useMutation({
    mutationFn: (data: Partial<BasicUser>) => updateUser(userId, data),
    onSuccess: () => {
      toast.success("User updated successfully!");
    },
    onError: (error) => {
      console.log(error);
      toast.error("Oops! Error", {
        description: "There was an error updating the user!",
      });
    },
  });
};

export const useDeleteUser = () => {
  return useMutation({
    mutationFn: (userId: string) => deleteUser(userId),
    onSuccess: () => {
      toast.success("User deleted successfully!");
    },
    onError: (error) => {
      console.log(error);
      toast.error("Oops! Error", {
        description: "There was an error deleting the user!",
      });
    },
  });
};
