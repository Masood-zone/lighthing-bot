import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

type AuthStoreActions = {
  setUser: (user: AuthenticatedUser | null) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  hasRole: (roles?: string[]) => boolean;
};

type AuthStoreState = AuthStore & AuthStoreActions;

export const useUserStore = create<AuthStoreState>()(
  persist(
    (set, get) => ({
      user: null,
      setUser: (user) => {
        if (user?.token) {
          localStorage.setItem("token", user.token);
        } else {
          localStorage.removeItem("token");
        }
        set({ user });
      },
      logout: () => {
        localStorage.removeItem("token");
        set({ user: null });
      },
      isAuthenticated: () => {
        const user = get().user;
        if (!user?.token) return false;
        if (!user.expiresAt) return false;
        return Date.now() < user.expiresAt;
      },
      hasRole: (roles = []) => {
        const user = get().user;
        const role = user?.user?.role;
        if (!roles.length) return true;
        if (!role) return false;
        return roles.includes(role);
      },
    }),
    {
      name: "auth-store",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ user: state.user }),
      onRehydrateStorage: () => (state) => {
        const user = state?.user;

        if (user?.token) {
          localStorage.setItem("token", user.token);
        } else {
          localStorage.removeItem("token");
        }

        if (user?.expiresAt && Date.now() >= user.expiresAt) {
          state?.logout();
        }
      },
    },
  ),
);
