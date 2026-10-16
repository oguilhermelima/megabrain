import type { NativeChat } from '@/api/schema'

export const nativeStateLabel: Record<NativeChat['state'], string> = {
  starting: 'starting',
  working: 'working',
  'waiting-approval': 'waiting approval',
  idle: 'idle',
  stopped: 'stopped',
  error: 'error',
}

