import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '@/api'
import type { AdmissionPolicy, Project, Settings } from '@/api/schema'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { SettingsSkeleton } from '@/components/Skeleton'
import { Button, ErrorNote } from '@/components/ui'
import { AgentsSection } from '@/settings/AgentsSection'
import { ChainsSection } from '@/settings/ChainsSection'
import { LimitsSection } from '@/settings/LimitsSection'
import { ModelsSection } from '@/settings/ModelsSection'
import { ProjectPage } from '@/settings/ProjectPage'
import { createLoads, sectionKeys } from '@/settings/settings-load'
import { groupReadingsByProvider } from '@/settings/settings-model'
import { adjacentKey, initialKey, navGroups, navKeys, projectKey, projectPathOf, sectionInfo, type NavKey, type Section } from '@/settings/settings-nav'
import { ghostIcon, SectionPage, SettingsIcon } from '@/settings/settings-ui'
import { ShortcutsSection } from '@/settings/ShortcutsSection'
import { KnowledgeSection } from '@/settings/KnowledgeSection'
import { SupervisorSection } from '@/settings/SupervisorSection'
import { TerminalSection } from '@/settings/TerminalSection'
import { setKnownTerminalEngine } from '@/terminal/terminal-engine'
import { UsageSection } from '@/settings/UsageSection'
import { WorktreesSection } from '@/settings/WorktreesSection'
import { pageX } from '@/lib/page'

/** `focusProject` opens on that project's page, as Edit commands in a chat's run menu does. `focusChat` is the native chat focused behind the window, for Summarize now. */
export function SettingsWindow({ onClose, onSetup, focusProject = null, focusChat = null, initialSection = null }: { onClose: () => void; onSetup: () => void; focusProject?: string | null; focusChat?: { id: string; title: string } | null; initialSection?: Section | null }) {
  const [section, setSection] = useState<NavKey>(initialSection ?? initialKey(focusProject, []))
  const [error, setError] = useState<unknown>(null)
  // Every listed project but the missing ones, for the Projects group and its pages.
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectsError, setProjectsError] = useState<unknown>(null)
  const nav = useRef<HTMLElement>(null)
  const content = useRef<HTMLElement>(null)

  // Every page loads only its own slice of the settings, once, and keeps it while the window is open.
  const loads = useMemo(
    () => createLoads(Object.fromEntries(Object.entries(sectionKeys).map(([key, keys]) => [key, () => (keys.length === 0 ? Promise.resolve({}) : api.settingsOnly(keys))]))),
    [],
  )
  useSyncExternalStore(loads.subscribe, loads.snapshot)
  const fixed = projectPathOf(section) === null ? (section as Section) : null
  useEffect(() => {
    if (fixed !== null) void loads.load(fixed)
  }, [fixed, loads])
  const reload = () => (fixed === null ? Promise.resolve() : loads.load(fixed, true))

  const reloadProjects = () =>
    api.projects('megabrain').then(
      (next) => {
        const present = next.filter((project) => !project.missing)
        setProjects(present)
        setProjectsError(null)
        // A focus on a worktree path opens its repository's page once the list names it.
        setSection((current) => (current === initialKey(focusProject, []) ? initialKey(focusProject, present) : current))
      },
      (caught: unknown) => setProjectsError(caught),
    )

  useEffect(() => void reloadProjects(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A block body: Chromium's scrollTo returns a promise, which React would call as the cleanup.
  useEffect(() => {
    content.current?.scrollTo({ top: 0 })
  }, [section])

  /** Runs a write, shows its error if it fails, re-reads settings either way; true when it worked. */
  const act = async (run: () => Promise<void>): Promise<boolean> => {
    let ok = false
    try {
      await run()
      setError(null)
      ok = true
    } catch (caught) {
      setError(caught)
    }
    await reload()
    return ok
  }

  // Up and down walk the sections while the navigation has focus, the way a sidebar list does.
  const go = (next: NavKey) => {
    setSection(next)
    nav.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(next)}"]`)?.focus()
  }

  const listed = projects ?? []
  const projectPath = projectPathOf(section)
  const project = projectPath === null ? null : (listed.find((item) => item.path === projectPath) ?? null)
  const info = sectionInfo(section)
  const entry = loads.get(section)
  // The page's slice only: each section reads the keys sectionKeys names for it.
  const settings = entry.value as Settings

  return (
    <div
      className="absolute inset-0 z-50 flex bg-ink-950/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="glass relative m-auto flex h-[min(760px,92vh)] w-[min(960px,94vw)] overflow-hidden rounded-[28px] border border-white/[0.1] shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close settings" title="Close (Esc)" className={`${ghostIcon} absolute top-3 right-3 z-10 size-8`}>
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <nav
          ref={nav}
          aria-label="Settings sections"
          className="flex w-[216px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-white/[0.06] px-3 pt-5 pb-4"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            go(adjacentKey(navKeys(listed), section, event.key === 'ArrowDown' ? 1 : -1))
          }}
        >
          <h1 className="px-3 text-[15px] font-semibold tracking-[-0.01em] text-ink-100">Settings</h1>
          {navGroups(listed).map((group) => (
            <div key={group.label} className={`grid gap-0.5 ${group.label === 'Projects' ? 'border-t border-white/[0.06] pt-4' : ''}`}>
              <p className="px-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-500 uppercase">{group.label}</p>
              {group.items.map((item) => {
                const current = section === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-section={item.key}
                    onClick={() => setSection(item.key)}
                    aria-current={current ? 'page' : undefined}
                    tabIndex={current ? 0 : -1}
                    title={item.project?.path}
                    className={`flex h-8 min-w-0 items-center gap-2.5 rounded-[10px] px-3 text-left text-[13.5px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${
                      current ? 'bg-white/[0.1] text-ink-100' : 'text-ink-300 hover:bg-white/[0.05] hover:text-ink-100'
                    }`}
                  >
                    {item.project === null ? (
                      <SettingsIcon name={sectionInfo(item.key).icon} className={`size-4 ${current ? 'text-ink-100' : 'text-ink-400'}`} />
                    ) : (
                      <span className="-ml-1 flex scale-[0.84]">
                        <ProjectPicture project={item.project} />
                      </span>
                    )}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <main ref={content} className={`min-h-0 flex-1 overflow-y-auto pt-8 pb-10 ${pageX}`}>
          {projectPath !== null ? (
            project !== null ? (
              <ProjectPage key={project.path} project={project} onChanged={() => void reloadProjects()} />
            ) : projectsError !== null ? (
              <ErrorNote error={projectsError} />
            ) : projects === null ? (
              <SettingsSkeleton />
            ) : (
              <p className="px-1 text-[13px] text-ink-400">This project is no longer listed.</p>
            )
          ) : entry.value === undefined ? (
            entry.status === 'error' ? (
              <div className="grid justify-items-start gap-3">
                <ErrorNote error={entry.error} />
                <Button onClick={() => void loads.load(fixed ?? 'usage')}>Retry</Button>
              </div>
            ) : (
              <SettingsSkeleton />
            )
          ) : (
            <SectionPage icon={info.icon} title={info.label} description={info.description}>
              {section === 'usage' && (
                <UsageSection
                  providers={groupReadingsByProvider(settings.limits.readings)}
                  enabledProviders={settings.limits.enabledProviders}
                  noticeEnabled={settings.limits.notice.enabled}
                  noticeIntervalMinutes={Math.round(settings.limits.notice.intervalSeconds / 60)}
                  error={error}
                  onToggleProvider={(provider, enabled) => void act(() => api.setLimitProvider(provider, enabled))}
                  onToggleNotice={(enabled) => void act(() => api.setLimitNotice(enabled))}
                  onChangeInterval={(minutes) => void act(() => api.setLimitNotice(settings.limits.notice.enabled, minutes * 60))}
                  onRefreshLimits={reload}
                />
              )}
              {section === 'agents' && <AgentsSection />}
              {section === 'chains' && (
                <ChainsSection
                  chains={settings.chains}
                  models={settings.models}
                  providers={[...new Set(groupReadingsByProvider(settings.limits.readings).map((group) => group.provider))]}
                  error={error}
                  run={act}
                />
              )}
              {section === 'knowledge' && <KnowledgeSection models={settings.models} chat={focusChat} projects={listed} focusProject={focusProject} />}
              {section === 'supervisor' && (
                <SupervisorSection
                  running={settings.supervisor.running}
                  pid={settings.supervisor.pid}
                  error={error}
                  onToggle={(running) => void act(() => api.setSupervisor(running))}
                  onSetup={() => {
                    onClose()
                    onSetup()
                  }}
                />
              )}
              {section === 'limits' && (
                <LimitsSection
                  policy={settings.resources.policy}
                  historyEnabled={settings.resources.historyEnabled}
                  error={error}
                  onSave={(policy: AdmissionPolicy) => void act(() => api.setPolicy(policy))}
                  onOff={() => void act(() => api.setPolicy(null))}
                  onToggleHistory={(enabled) => void act(() => api.setResourceHistory(enabled))}
                />
              )}
              {section === 'worktrees' && <WorktreesSection projects={listed} onOpenProject={(path) => go(projectKey(path))} />}
              {section === 'shortcuts' && <ShortcutsSection />}
              {section === 'models' && <ModelsSection models={settings.models} error={error} onSaved={act} onRefresh={async (agent) => void (await act(() => api.refreshModels(agent)))} />}
              {section === 'terminal' && (
                <TerminalSection
                  engine={settings.terminalEngine ?? 'native'}
                  terminal={settings.terminal}
                  error={error}
                  onChange={(engine) =>
                    void act(async () => {
                      await api.setTerminalEngine(engine)
                      setKnownTerminalEngine(engine)
                    })
                  }
                  onSetTerminal={(name) => void act(() => api.setTerminalDefault(name))}
                />
              )}
            </SectionPage>
          )}
        </main>
      </div>
    </div>
  )
}
