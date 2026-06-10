/// <reference types="vite/client" />

import type { SkySqlApi } from '@shared/ipc'

declare global {
  interface Window {
    skysql: SkySqlApi
  }
}

export {}
