import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Artifact, ArtifactKind } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { artifactKindLabel, artifactsForTopic } from '@/advanced/artifacts-model'
import { useNow } from '@/github/parts'

// The artifacts filed under one topic, as a row of cards, for the knowledge lane's topic page. A
// card opens the artifact on the Artifacts page; with none filed the strip renders nothing.

/** Each kind's mark: a diagram's linked boxes, a plan's checklist, a doc's page. */
export function ArtifactKindIcon({ kind }: { kind: ArtifactKind }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'diagram' ? (
        <>
          <rect x="1.75" y="2.25" width="5" height="4" rx="1" />
          <rect x="9.25" y="9.75" width="5" height="4" rx="1" />
          <path d="M4.25 6.25v3.5a1.5 1.5 0 0 0 1.5 1.5h3.5" />
        </>
      ) : kind === 'plan' ? (
        <>
          <path d="m2.25 4 1.25 1.25L5.75 3M2.25 10.5l1.25 1.25 2.25-2.25" />
          <path d="M8 4.25h5.75M8 10.75h5.75" />
        </>
      ) : (
        <>
          <path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5Z" />
          <path d="M9.5 1.75V5h3.25M5.5 8.5h5M5.5 11h3.5" />
        </>
      )}
    </svg>
  )
}

export function ArtifactStrip({ topic, onOpen }: { topic: string; onOpen: (artifact: Artifact) => void }) {
  const now = useNow(30_000)
  const [artifacts, setArtifacts] = useState<{ topic: string; list: Artifact[] } | null>(null)
  useEffect(() => {
    let current = true
    api.artifacts({ topic }).then(
      (next) => current && setArtifacts({ topic, list: artifactsForTopic(next.artifacts, topic) }),
      // A strip that cannot load is left out; the topic page reads fine without it.
      () => current && setArtifacts({ topic, list: [] }),
    )
    return () => {
      current = false
    }
  }, [topic])
  const list = artifacts?.topic === topic ? artifacts.list : []
  if (list.length === 0) return null
  return (
    <section aria-label="Artifacts" className="space-y-3">
      <h2 className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">Artifacts</h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {list.map((artifact) => (
          <li key={artifact.id}>
            <button
              type="button"
              onClick={() => onOpen(artifact)}
              title={artifact.title}
              className="flex w-full min-w-0 flex-col gap-2 rounded-[14px] border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-left transition-colors hover:bg-white/[0.07]"
            >
              <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">
                <ArtifactKindIcon kind={artifact.kind} />
                {artifactKindLabel(artifact.kind)} · {relativeAge(artifact.updatedAt, now)}
              </span>
              <span className="truncate text-[13.5px] font-medium text-ink-100">{artifact.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
