import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { AdmissionPolicy, Chain, Settings } from '@/api/schema'
import { SettingsSkeleton } from '@/components/Skeleton'
import { ChainsSection } from '@/settings/ChainsSection'
import { LimitsSection } from '@/settings/LimitsSection'
import { ModelsSection } from '@/settings/ModelsSection'
import { ProjectsSection } from '@/settings/ProjectsSection'
import { groupReadingsByProvider } from '@/settings/settings-model'
import { adjacentSection, initialSection, navGroups, sectionInfo, type Section } from '@/settings/settings-nav'
import { ghostIcon, SectionPage, SettingsIcon } from '@/settings/settings-ui'
import { SupervisorSection } from '@/settings/SupervisorSection'
import { TerminalSection } from '@/settings/TerminalSection'
import { setKnownTerminalEngine } from '@/terminal/terminal-engine'
import { UsageSection } from '@/settings/UsageCard'

/** `focusProject` opens on that project's commands, as Edit commands in a chat's run menu does. */
export function SettingsWindow({ onClose, onSetup, focusProject = null }: { onClose: () => void; onSetup: () => void; focusProject?: string | null }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [section, setSection] = useState<Section>(initialSection(focusProject))
  const [error, setError] = useState<unknown>(null)
  const nav = useRef<HTMLElement>(null)
  const content = useRef<HTMLElement>(null)

  const reload = () => api.settings().then(setSettings, (caught: unknown) => setError(caught))

  useEffect(() => void reload(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => content.current?.scrollTo({ top: 0 }), [section])

  const act = async (run: () => Promise<void>) => {
    try {
      await run()
      setError(null)
    } catch (caught) {
      setError(caught)
    }
    await reload()
  }

  // Up and down walk the sections while the navigation has focus, the way a sidebar list does.
  const go = (next: Section) => {
    setSection(next)
    nav.current?.querySelector<HTMLElement>(`[data-section="${next}"]`)?.focus()
  }

  const info = sectionInfo(section)

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
            go(adjacentSection(section, event.key === 'ArrowDown' ? 1 : -1))
          }}
        >
          <h1 className="px-3 text-[15px] font-semibold tracking-[-0.01em] text-ink-100">Settings</h1>
          {navGroups().map((group) => (
            <div key={group.label} className="grid gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-ink-500 uppercase">{group.label}</p>
              {group.sections.map((item) => {
                const current = section === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-section={item.key}
                    onClick={() => setSection(item.key)}
                    aria-current={current ? 'page' : undefined}
                    tabIndex={current ? 0 : -1}
                    className={`flex h-8 items-center gap-2.5 rounded-[10px] px-3 text-left text-[13.5px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${
                      current ? 'bg-white/[0.1] text-ink-100' : 'text-ink-300 hover:bg-white/[0.05] hover:text-ink-100'
                    }`}
                  >
                    <SettingsIcon name={item.icon} className={`size-4 ${current ? 'text-ink-100' : 'text-ink-400'}`} />
                    {item.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <main ref={content} className="min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-10">
          {settings === null ? (
            <SettingsSkeleton />
          ) : (
            <SectionPage icon={info.icon} title={info.label} description={info.description}>
              {section === 'projects' && <ProjectsSection focusProject={focusProject} />}
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
                />
              )}
              {section === 'chains' && (
                <ChainsSection
                  chains={settings.chains}
                  models={settings.models}
                  error={error}
                  onSave={(chain: Chain) => void act(() => api.saveChain(chain))}
                  onDelete={(name: string) => void act(() => api.deleteChain(name))}
                />
              )}
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
              {section === 'models' && <ModelsSection models={settings.models} error={error} onRefresh={(agent) => act(() => api.refreshModels(agent))} />}
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
