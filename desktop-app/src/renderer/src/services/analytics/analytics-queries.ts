import { useQuery } from "@tanstack/react-query";
import { getAnalytics } from "./analytics-api";

export const useAnalyticsQueries = () => {
  const analyticsQuery = useQuery({
    queryKey: ["analytics"],
    queryFn: getAnalytics,
  });
  return {
    analyticsQuery,
  };
};
