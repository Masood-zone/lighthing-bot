import axios from "axios";

export const apiClient = axios.create({
  baseURL: "http://localhost:3001/api",
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  },
});

// Add a request interceptor to always use the latest token
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers = config.headers || {};
    config.headers["Authorization"] = `Bearer ${token}`;
  } else if (config.headers) {
    delete config.headers["Authorization"];
  }
  return config;
});
