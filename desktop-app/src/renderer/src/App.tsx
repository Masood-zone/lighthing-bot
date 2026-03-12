import { RouterProvider } from "react-router-dom";
import rootRoutes from "./pages/root.routes";
import { Toaster } from "./components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

export default function App() {
  return (
    <>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={rootRoutes} />
        <Toaster />
      </QueryClientProvider>
    </>
  );
}
