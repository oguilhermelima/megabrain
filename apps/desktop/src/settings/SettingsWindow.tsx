import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { AdmissionPolicy, Chain, Settings } from '@/api/schema'
import { Spinner } from '@/components/ui'
import { ChainsSection } from '@/settings/ChainsSection'
import { LimitsSection } from '@/settings/LimitsSection'
import { ModelsSection } from '@/settings/ModelsSection'
import { groupReadingsByProvider } from '@/settings/settings-model'
import { SupervisorSection } from '@/settings/SupervisorSection'
import { UsageSection } from '@/settings/UsageCard'

type Section = 'usage' | 'chains' | 'supervisor' | 'limits' | 'models'

const sections: { key: Section; label: string }[] = [
  { key: 'usage', label: 'Usage' },
  { key: 'chains', label: 'Chains' },
  { key: 'supervisor', label: 'Supervisor' },
  { key: 'limits', label: 'Limits' },
  { key: 'models', label: 'Models and terminal' },
]

export function SettingsWindow({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [section, setSection] = useState<Section>('usage')
  const [error, setError] = useState<unknown>(null)

  const reload = () => api.settings().then(setSettings, (caught: unknown) => setError(caught))

  useEffect(() => void reload(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const act = async (run: () => Promise<void>) => {
    try {
      await run()
      setError(null)
    } catch (caught) {
      setError(caught)
    }
    await reload()
  }

  return (
    <div className="absolute inset-0 z-50 flex bg-ink-950/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="glass relative m-auto flex h-[min(760px,92vh)] w-[min(960px,94vw)] overflow-hidden rounded-[28px] border border-white/[0.08]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          title="Close (Esc)"
          className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full text-ink-400 hover:bg-white/[0.1] hover:text-ink-200"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
        <aside className="flex w-[220px] flex-col gap-1 border-r border-white/[0.06] p-4">
          <h2 className="px-2 pb-3 text-[15px] font-semibold text-ink-100">Settings</h2>
          {sections.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={`rounded-xl px-3 py-2 text-left text-[13.5px] font-medium ${section === item.key ? 'bg-white/[0.1] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
            >
              {item.label}
            </button>
          ))}
        </aside>
        <main className="min-h-0 flex-1 overflow-y-auto p-6 pt-6">
          {settings === null ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <>
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
              {section === 'models' && (
                <ModelsSection
                  models={settings.models}
                  terminal={settings.terminal}
                  error={error}
                  onRefresh={(agent) => act(() => api.refreshModels(agent))}
                  onSetTerminal={(name) => void act(() => api.setTerminalDefault(name))}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
