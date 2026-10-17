import { useRef, useState } from 'react'
import { api } from '@/api'
import { sessionsOfOrigin } from '@/api/projects-origin'
import type { NativeChat, Project } from '@/api/schema'
import { initialLoad, settleLoad, type LatestLoad } from '@/lib/latest-load'
import { projectsPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'
import { useStableCallback } from '@/lib/useStableCallback'

const noProjects: Project[] = []

export function useProjects(): { projects: Project[]; chats: NativeChat[]; loaded: boolean; chatsLoaded: boolean; error: unknown; retry: () => void; dropChat: (id: string) => void } {
  const [load, setLoad] = useState<LatestLoad<Project[]>>(initialLoad)
  const [chats, setChats] = useState<NativeChat[]>([])
  const [chatsLoaded, setChatsLoaded] = useState(false)
  const seq = useRef(0)
  const retry = usePoll(
    projectsPolicy,
    async (current) => {
      const at = ++seq.current
      try {
        // Native chats ride the projects poll; a CLI without them leaves the list empty.
        const [next, nextChats] = await Promise.all([api.projects('megabrain'), api.chats().catch(() => null)])
        if (!current()) return
        // Only sessions megabrain started; one opened in Orca or a plain terminal belongs there.
        const mine = sessionsOfOrigin(next, 'megabrain')
        setLoad((previous) => settleLoad(previous, { seq: at, ok: true, value: reuse(previous.value ?? [], mine) }))
        if (nextChats !== null) {
          setChats((previous) => reuse(previous, nextChats))
          setChatsLoaded(true)
        }
      } catch (error) {
        // The last good list stays; usePoll tries again sooner.
        if (current()) setLoad((previous) => settleLoad(previous, { seq: at, ok: false, error }))
        throw error
      }
    },
    [],
  )
  // A removed chat leaves the list at once instead of at the next poll.
  const dropChat = useStableCallback((id: string) => setChats((previous) => previous.filter((chat) => chat.id !== id)))
  return { projects: load.value ?? noProjects, chats, loaded: load.value !== null, chatsLoaded, error: load.error, retry, dropChat }
}
