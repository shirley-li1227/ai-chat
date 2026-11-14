/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基址，留空表示同源（由 Nginx 反代或 NestJS 托管静态资源） */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
