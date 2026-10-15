import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { PathLink } from '@/api/adapter'
import type { DoctorReport, InstallPlan } from '@/api/schema'
import { Badge, Button, Card, Check, ErrorNote, Mono, Segmented, Spinner, doctorTone } from '@/components/ui'
import { emptyProgress, groupModules, initialSelection, installArgs, moduleRetryArgs, reduceInstall, removals, type InstallProgress, type Selection } from '@/onboarding/model'

const steps = ['Command line', 'Environment', 'Choose', 'Install', 'Health'] as const

export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState(0)
  const [plan, setPlan] = useState<InstallPlan | null>(null)
  const [planError, setPlanError] = useState<unknown>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [confirmRemovals, setConfirmRemovals] = useState(false)

  useEffect(() => {
    api.installPlan().then(
      (loaded) => {
        setPlan(loaded)
        setSelection(initialSelection(loaded))
      },
      setPlanError,
    )
  }, [])

  const next = () => setStep((current) => Math.min(current + 1, steps.length - 1))
  const back = () => setStep((current) => Math.max(current - 1, 0))

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900 px-5 py-6">
        <div className="mb-8 flex items-center gap-2.5">
          <img src="/icon.png" alt="" className="size-7 rounded-md" />
          <div>
            <div className="text-[14px] font-semibold text-ink-100">megabrain</div>
            <div className="text-[11px] text-ink-400">Setup{plan === null ? '' : ` · v${plan.version}`}</div>
          </div>
        </div>
        <ol className="space-y-1">
          {steps.map((name, index) => (
            <li
              key={name}
              className={`flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] ${index === step ? 'bg-ink-800 text-ink-100' : index < step ? 'text-ink-300' : 'text-ink-500'}`}
            >
              <span
                className={`flex size-5 items-center justify-center rounded-full text-[11px] font-semibold ${
                  index < step ? 'bg-accent/20 text-accent' : index === step ? 'bg-accent text-ink-950' : 'bg-ink-800 text-ink-500'
                }`}
              >
                {index < step ? '✓' : index + 1}
              </span>
              {name}
            </li>
          ))}
        </ol>
        <p className="mt-auto text-[11px] leading-relaxed text-ink-500">
          Everything here runs the megabrain command line. You can run this setup again from the main window.
        </p>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
          {planError !== null && <ErrorNote error={planError} />}
          {step === 0 && <CommandLineStep />}
          {step === 1 && plan !== null && <EnvironmentStep plan={plan} />}
          {step === 2 && plan !== null && selection !== null && (
            <ChooseStep plan={plan} selection={selection} onChange={setSelection} confirmRemovals={confirmRemovals} onConfirmRemovals={setConfirmRemovals} />
          )}
          {step === 3 && selection !== null && <InstallStep args={installArgs(selection, confirmRemovals)} />}
          {step === 4 && <HealthStep />}
          {step > 0 && plan === null && planError === null && <Loading what="Reading this machine" />}
        </div>
        <footer className="flex items-center justify-between border-t border-ink-800 px-10 py-4">
          <Button variant="ghost" onClick={back} disabled={step === 0}>
            Back
          </Button>
          {step < steps.length - 1 ? (
            <Button variant="primary" onClick={next} disabled={step > 0 && plan === null}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={onFinish}>
              Open megabrain
            </Button>
          )}
        </footer>
      </main>
    </div>
  )
}

function Heading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <header className="mb-6 max-w-2xl">
      <h2 className="text-[20px] font-semibold text-ink-100">{title}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-400">{children}</p>
    </header>
  )
}

function Loading({ what }: { what: string }) {
  return (
    <div className="flex items-center gap-2 text-ink-400">
      <Spinner /> {what}…
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start gap-3 py-1.5">
      <div className="text-[12px] text-ink-400">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const linkLabels: Record<PathLink['kind'], { tone: 'ok' | 'warn' | 'neutral' | 'bad'; text: string }> = {
  ours: { tone: 'ok', text: 'linked to this app' },
  missing: { tone: 'neutral', text: 'not linked' },
  'other-link': { tone: 'warn', text: 'points elsewhere' },
  file: { tone: 'bad', text: 'a file is in the way' },
}

function CommandLineStep() {
  const [link, setLink] = useState<PathLink | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [replacing, setReplacing] = useState(false)

  useEffect(() => {
    api.pathLink().then(setLink, setError)
  }, [])

  const apply = (replace: boolean) => {
    setBusy(true)
    setError(null)
    api
      .linkCli(replace)
      .then(setLink, setError)
      .finally(() => {
        setBusy(false)
        setReplacing(false)
      })
  }

  return (
    <>
      <Heading title="The megabrain command">
        Agents run <Mono>megabrain</Mono> from your terminal. This app carries its own copy of the command line; link it so that copy is the one
        they find. Linking is optional, and a link that points somewhere else is only replaced if you say so.
      </Heading>
      {error !== null && <ErrorNote error={error} />}
      {link === null ? (
        error === null && <Loading what="Looking at your PATH" />
      ) : (
        <Card title="Command line" aside={<Badge tone={linkLabels[link.kind].tone}>{linkLabels[link.kind].text}</Badge>} className="max-w-3xl">
          <Row label="Link">
            <Mono>{link.linkPath}</Mono>
          </Row>
          {link.pointsTo !== null && (
            <Row label="Points to">
              <Mono>{link.pointsTo}</Mono>
            </Row>
          )}
          <Row label="This app's copy">
            <Mono>{link.bundled}</Mono>
          </Row>
          <Row label="megabrain runs">{link.resolvesTo === null ? <span className="text-ink-400">nothing on your PATH answers to megabrain</span> : <Mono>{link.resolvesTo}</Mono>}</Row>
          {link.bundled.includes('/AppTranslocation/') && (
            <p className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
              macOS is running this app from a temporary copy. Move megabrain to Applications and open it again before linking, or the link will
              break.
            </p>
          )}
          {!link.dirOnPath && (
            <p className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
              <Mono>~/.local/bin</Mono> is not on your PATH, so agents will not find the link. Add it in your shell profile.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {link.kind === 'missing' && (
              <Button variant="primary" onClick={() => apply(false)} disabled={busy}>
                {busy && <Spinner />} Link the command
              </Button>
            )}
            {link.kind === 'other-link' &&
              (replacing ? (
                <>
                  <span className="text-[12px] text-ink-300">Replace the link to {link.pointsTo}?</span>
                  <Button variant="danger" onClick={() => apply(true)} disabled={busy}>
                    {busy && <Spinner />} Replace it
                  </Button>
                  <Button variant="ghost" onClick={() => setReplacing(false)} disabled={busy}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button onClick={() => setReplacing(true)}>Use this app's copy instead</Button>
              ))}
            {link.kind === 'file' && <span className="text-[12px] text-ink-400">Move that file away to link this app's copy; the app never replaces a file.</span>}
            {link.kind === 'ours' && <span className="text-[12px] text-ink-400">Nothing to do.</span>}
          </div>
        </Card>
      )}
    </>
  )
}

function EnvironmentStep({ plan }: { plan: InstallPlan }) {
  const hosts = [
    { name: 'tmux', present: plan.hosts.tmux, note: 'runs agents in split panes; the default runtime' },
    { name: 'Orca', present: plan.hosts.orca, note: 'opens agents as IDE tabs' },
    { name: 'Superset', present: plan.hosts.superset, note: 'opens agents as IDE tabs' },
  ]
  return (
    <>
      <Heading title="What is on this machine">What megabrain found. Nothing has been changed yet.</Heading>
      <div className="grid max-w-4xl grid-cols-2 gap-4">
        <Card title="Agents">
          <ul className="space-y-2">
            {plan.agents.map((agent) => (
              <li key={agent.agent} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-ink-100">{agent.label}</div>
                  {agent.configDir !== null && <div className="truncate font-mono text-[11px] text-ink-500">{agent.configDir}</div>}
                </div>
                <Badge tone={agent.installed ? 'ok' : 'neutral'}>{agent.installed ? 'installed' : 'not found'}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Where agents run">
          <ul className="space-y-2">
            {hosts.map((host) => (
              <li key={host.name} className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-ink-100">{host.name}</div>
                  <div className="text-[11px] text-ink-500">{host.note}</div>
                </div>
                <Badge tone={host.present ? 'ok' : 'neutral'}>{host.present ? 'found' : 'not found'}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <p className="mt-4 max-w-4xl text-[12px] leading-relaxed text-ink-500">
        Web browser testing runs Playwright through Node, so it needs Node 22 or later even though megabrain itself does not.
      </p>
    </>
  )
}

function ChooseStep({
  plan,
  selection,
  onChange,
  confirmRemovals,
  onConfirmRemovals,
}: {
  plan: InstallPlan
  selection: Selection
  onChange: (selection: Selection) => void
  confirmRemovals: boolean
  onConfirmRemovals: (confirm: boolean) => void
}) {
  const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((entry) => entry !== item))
  const removing = removals(plan, selection)
  const labels = new Map(plan.modules.map((module) => [module.module, module.label]))
  return (
    <>
      <Heading title="Choose what to set up">
        Preselected is what megabrain recommends for this machine{plan.previous === null ? '' : ', starting from your last setup'}. Opt-in modules stay
        off unless you pick them.
      </Heading>
      <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4">
        <div className="space-y-4">
          <Card title="Coding agents">
            {plan.agents.map((agent) => (
              <Check
                key={agent.agent}
                checked={selection.agents.includes(agent.agent)}
                disabled={!agent.installed}
                onChange={(on) => onChange({ ...selection, agents: toggle(selection.agents, agent.agent, on) })}
              >
                <span className="text-ink-100">{agent.label}</span>
                {!agent.installed && <span className="ml-2 text-[11px] text-ink-500">not installed</span>}
              </Check>
            ))}
          </Card>
          <Card title="Skill">
            <Segmented
              value={selection.skill}
              onChange={(skill) => onChange({ ...selection, skill })}
              options={[
                { value: 'global', label: 'Every project' },
                { value: 'project', label: 'This project' },
                { value: 'none', label: 'None' },
              ]}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-ink-500">The megabrain skill teaches the selected agents to use these tools.</p>
          </Card>
          <Card title="tmux">
            <Segmented
              value={selection.tmux}
              disabled={!plan.hosts.tmux}
              onChange={(tmux) => onChange({ ...selection, tmux })}
              options={[
                { value: 'yes', label: 'Use tmux' },
                { value: 'no', label: 'No' },
              ]}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
              {plan.hosts.tmux ? 'Agents open in tmux splits, with the megabrain theme and agent badges.' : 'tmux is not installed.'}
            </p>
          </Card>
        </div>
        <div className="space-y-4">
          {groupModules(plan).map((group) => (
            <Card key={group.group} title={group.group}>
              {group.modules.map((module) => (
                <Check
                  key={module.module}
                  checked={selection.modules.includes(module.module)}
                  disabled={module.unavailable}
                  onChange={(on) => onChange({ ...selection, modules: toggle(selection.modules, module.module, on) })}
                >
                  <span className="text-ink-100">{module.label}</span>
                  <span className="block text-[11px] leading-relaxed text-ink-500">{module.reason ?? module.hint}</span>
                </Check>
              ))}
            </Card>
          ))}
          {removing.length > 0 && (
            <Card title="Removing">
              <p className="mb-2 text-[12px] text-ink-300">These were set up before and are now unselected: {removing.map((module) => labels.get(module) ?? module).join(', ')}.</p>
              <Check checked={confirmRemovals} onChange={onConfirmRemovals}>
                <span className="text-ink-100">Remove them</span>
                <span className="block text-[11px] text-ink-500">Left unchecked, they stay installed.</span>
              </Check>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

const stepTone = { running: 'accent', done: 'ok', failed: 'bad' } as const

function InstallStep({ args }: { args: string[] }) {
  const [progress, setProgress] = useState<InstallProgress>(emptyProgress)
  const [phase, setPhase] = useState<'ready' | 'running' | 'finished'>('ready')
  const [error, setError] = useState<unknown>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  const start = () => {
    setPhase('running')
    setProgress(emptyProgress)
    setError(null)
    api
      .install(args, (event) => setProgress((current) => reduceInstall(current, event)))
      .then((exit) => {
        if (exit.code !== 0 && exit.stderr.trim() !== '') setError(new Error(exit.stderr.trim()))
      }, setError)
      .finally(() => setPhase('finished'))
  }

  // A retry can fix what the run reported, so the outcome is read from the steps as they are now.
  const failing = progress.steps.filter((step) => step.state === 'failed')
  const outcome = progress.result === null ? null : !progress.result.ok && failing.length === 0 ? 'Everything is set up.' : progress.result.message

  const retry = (module: string) => {
    setRetrying(module)
    api
      .installModule(moduleRetryArgs(module))
      .then((result) =>
        setProgress((current) =>
          reduceInstall(current, { type: 'step', module, label: current.steps.find((step) => step.key === module)?.label ?? module, state: result.ok ? 'done' : 'fail', message: result.message }),
        ),
      )
      .catch(setError)
      .finally(() => setRetrying(null))
  }

  return (
    <>
      <Heading title="Install">
        Runs <Mono>megabrain {args.join(' ')}</Mono>
      </Heading>
      {phase === 'ready' && (
        <Button variant="primary" onClick={start}>
          Start
        </Button>
      )}
      {phase !== 'ready' && (
        <div className="max-w-3xl space-y-4">
          <Card title="Steps" aside={phase === 'running' ? <Spinner /> : progress.result !== null && <Badge tone={failing.length === 0 ? 'ok' : 'warn'}>{failing.length === 0 ? 'done' : 'done with problems'}</Badge>}>
            {progress.steps.length === 0 && <Loading what="Starting" />}
            <ul className="space-y-1">
              {progress.steps.map((step) => (
                <li key={step.key} className="rounded-md px-2 py-1.5 hover:bg-ink-850">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink-100">{step.label}</span>
                    <span className="flex items-center gap-2">
                      {step.state === 'failed' && step.module !== null && phase === 'finished' && (
                        <Button variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => retry(step.module ?? '')} disabled={retrying !== null}>
                          {retrying === step.module && <Spinner />} Retry
                        </Button>
                      )}
                      <Badge tone={stepTone[step.state]}>{step.state}</Badge>
                    </span>
                  </div>
                  {step.message !== null && step.state === 'failed' && <p className="mt-1 text-[12px] text-bad select-text">{step.message}</p>}
                </li>
              ))}
            </ul>
          </Card>
          {progress.log.length > 0 && (
            <Card title="Notes">
              <ul className="space-y-1 text-[12px]">
                {progress.log.map((entry, index) => (
                  <li key={index} className={entry.level === 'warn' ? 'text-warn' : 'text-ink-300'}>
                    {entry.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {outcome !== null && <p className="text-[13px] text-ink-300">{outcome}</p>}
          {error !== null && <ErrorNote error={error} />}
          {phase === 'finished' && (
            <Button onClick={start} disabled={retrying !== null}>
              Run again
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function HealthStep() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState<unknown>(null)
  const check = () => {
    setReport(null)
    setError(null)
    api.doctor().then(setReport, setError)
  }
  useEffect(check, [])
  return (
    <>
      <Heading title="Health">
        What <Mono>megabrain doctor</Mono> says about each module now.
      </Heading>
      {error !== null && <ErrorNote error={error} />}
      {report === null ? (
        error === null && <Loading what="Checking every module" />
      ) : (
        <Card title="Modules" aside={<Button variant="ghost" className="h-6 px-2 text-[12px]" onClick={check}>Check again</Button>} className="max-w-4xl">
          <ul className="divide-y divide-ink-800">
            {report.map((entry) => (
              <li key={entry.module} className="grid grid-cols-[180px_110px_1fr] items-start gap-3 py-2">
                <span className="text-ink-100">{entry.module}</span>
                <span>
                  <Badge tone={doctorTone(entry.status)}>{entry.status}</Badge>
                </span>
                <span className="text-[12px] leading-relaxed text-ink-400 select-text">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
