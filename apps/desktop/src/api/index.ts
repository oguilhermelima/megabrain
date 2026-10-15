import type { DesktopApi } from '@/api/adapter'
import { createMockApi } from '@/api/mock'
import { createTauriApi } from '@/api/tauri'
import { native } from '@/lib/surface'

export const api: DesktopApi = native ? createTauriApi() : createMockApi()
