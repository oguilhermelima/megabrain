import type { DesktopApi } from '@/api/adapter'
import { createMockApi } from '@/api/mock'
import { createTauriApi } from '@/api/tauri'

const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const api: DesktopApi = inTauri ? createTauriApi() : createMockApi()
