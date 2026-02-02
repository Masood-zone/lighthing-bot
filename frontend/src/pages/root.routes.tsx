import Error from "@/components/error/error";
import ErrorBoundary from "@/components/error/error-boundary";
import RootLayout from "@/components/layout";
import AdminLayout from "@/components/layout/admin-layout.tsx";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
} from "react-router-dom";
import Dashboard from "./admin/dashboard/dashboard.tsx";
import ProtectedRoute from "./protected.routes.tsx";

const rootRoutes = createBrowserRouter(
  createRoutesFromElements(
    <>
      {/* Base Layout */}
      <Route
        path="/"
        element={
          <ErrorBoundary
            fallback={({ error, reset }) => (
              <Error error={error} reset={reset} />
            )}
          >
            <RootLayout />
          </ErrorBoundary>
        }
      >
        {/* Login */}
        <Route
          index
          lazy={async () => {
            const { default: Login } = await import("@/pages/auth/login");
            return { Component: Login };
          }}
        />
        {/* Not found */}
        <Route
          path="*"
          lazy={async () => {
            const { default: NotFound } =
              await import("../pages/not-found/not-found.tsx");
            return { Component: NotFound };
          }}
        />
      </Route>
      {/* Admin Dashboard */}
      <Route
        path="admin"
        element={
          <ProtectedRoute roles={["ADMIN"]}>
            <ErrorBoundary
              fallback={({ error, reset }) => (
                <Error error={error} reset={reset} />
              )}
            >
              <AdminLayout />
            </ErrorBoundary>
          </ProtectedRoute>
        }
      >
        {/* Dashboard */}
        <Route
          index
          element={
            <ErrorBoundary
              fallback={({ error, reset }) => (
                <Error error={error} reset={reset} />
              )}
            >
              <Dashboard />
            </ErrorBoundary>
          }
        />
        {/* Users */}
        <Route
          path="users"
          lazy={async () => {
            const { default: UsersLayout } = await import("./admin/users");
            return { Component: UsersLayout };
          }}
        >
          <Route
            index
            lazy={async () => {
              const { default: Users } = await import("./admin/users/users");
              return { Component: Users };
            }}
          />
          <Route
            path=":id"
            lazy={async () => {
              const { default: UserDetails } =
                await import("./admin/users/[id]/user");
              return { Component: UserDetails };
            }}
          />
          <Route
            path="create"
            lazy={async () => {
              const { default: CreateUserPage } =
                await import("./admin/users/create/create-user");
              return { Component: CreateUserPage };
            }}
          />
        </Route>

        {/* Bookins */}
        <Route
          path="bookings"
          lazy={async () => {
            const { default: BookingsLayout } =
              await import("./admin/bookings");
            return { Component: BookingsLayout };
          }}
        >
          <Route
            index
            lazy={async () => {
              const { default: BookingsPage } =
                await import("./admin/bookings/bookings");
              return { Component: BookingsPage };
            }}
          />
        </Route>
      </Route>
      {/* Not found */}
      <Route
        path="*"
        lazy={async () => {
          const { default: NotFound } =
            await import("../pages/not-found/not-found.tsx");
          return { Component: NotFound };
        }}
      />
    </>,
  ),
);

export default rootRoutes;
