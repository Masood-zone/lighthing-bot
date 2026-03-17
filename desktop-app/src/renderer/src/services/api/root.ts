import axios from 'axios'

function getRuntimeApiUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    const v = params.get('apiUrl')
    return v ? v : null
  } catch {
    return null
  }
}

export const ROOT_URL =
  getRuntimeApiUrl() ??
  import.meta.env.VITE_API_URL ??
  import.meta.env.REACT_APP_API_URL ??
  'http://127.0.0.1:3001/api'

export const apiClient = axios.create({
  // baseURL: "http://localhost:3001/api",
  baseURL: ROOT_URL,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  }
})

// Add a request interceptor to always use the latest token
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers = config.headers || {}
    config.headers['Authorization'] = `Bearer ${token}`
  } else if (config.headers) {
    delete config.headers['Authorization']
  }
  return config
})
