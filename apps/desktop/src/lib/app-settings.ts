import { api } from '@/api'
import { settingsSchema, type Settings } from '@/api/schema'
import { onFocus, onVisibility, windowShows } from '@/lib/app-events'
import { keepKnownReadings } from '@/lib/known-readings'
import { createLiveRead, type LiveRead } from '@/lib/live-read'
import { storageCache } from '@/lib/shared-read'

// Settings carry the agents' 5-hour and weekly limits and the model list. They belong to the app,
// not to a chat: one read serves every composer, starts with the app, and keeps the last good
// reading in local storage so a row paints from it at once.
let live: LiveRead<Settings> | null = null

export function appSettings(): LiveRead<Settings> {
  if (live !== null) return live
  const store = createLiveRead(async () => keepKnownReadings(live?.get() ?? null, await api.settings()), {
    cache: storageCache<Settings>(
      () => window.localStorage,
      'megabrain.composer.settings',
      1,
      (raw) => {
        const parsed = settingsSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      },
    ),
    clock: {
      now: () => Date.now(),
      visible: windowShows,
      setTimer: (run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      },
    },
  })
  onVisibility(() => store.visibilityChanged())
  onFocus(() => store.focused())
  live = store
  return store
}

/** Begins reading at app start, so the first pane finds the limits there. */
export function startAppSettings() {
  appSettings().start()
}
