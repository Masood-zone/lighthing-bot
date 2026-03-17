/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly REACT_APP_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
