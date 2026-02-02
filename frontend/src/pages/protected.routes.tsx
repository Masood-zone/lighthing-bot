import { useUserStore } from "@/store/user-store";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";

interface ProtectedRouteProps {
  children: React.ReactElement;
  roles?: string[];
}

const ProtectedRoute = ({ children, roles = [] }: ProtectedRouteProps) => {
  const navigate = useNavigate();
  const { user, logout } = useUserStore();

  const role = user?.user?.role ?? "";
  const expiresAt = user?.expiresAt;

  const expiryTime = useMemo(() => {
    if (expiresAt == null) return null;
    return typeof expiresAt === "string"
      ? new Date(expiresAt).getTime()
      : expiresAt;
  }, [expiresAt]);

  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    let timeoutId: number | null = null;

    const schedule = (next: boolean) => {
      window.setTimeout(() => setIsExpired(next), 0);
    };

    if (!user || expiryTime == null) {
      schedule(false);
      return () => {
        if (timeoutId != null) window.clearTimeout(timeoutId);
      };
    }

    const now = Date.now();
    if (now >= expiryTime) {
      schedule(true);
      return () => {
        if (timeoutId != null) window.clearTimeout(timeoutId);
      };
    }

    schedule(false);
    timeoutId = window.setTimeout(() => setIsExpired(true), expiryTime - now);

    return () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [user, expiryTime]);

  useEffect(() => {
    if (!user) {
      toast.error("You need to be logged in to access this page.");
      return;
    }

    if (isExpired) {
      logout();
      toast.error("Session expired", {
        description: "Please login again.",
      });
      navigate("/");
      return;
    }

    if (roles.length && role && !roles.includes(role)) {
      toast.error("You do not have permission to access this page.");
      navigate("/");
    }
  }, [user, isExpired, logout, navigate, roles, role]);

  // Redirect unauthenticated users
  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (isExpired) {
    return <Navigate to="/" replace />;
  }

  if (roles.length && role && !roles.includes(role)) {
    return <Navigate to="/" replace />;
  }

  return children;
};

export default ProtectedRoute;
