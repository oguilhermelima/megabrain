import { z } from 'zod'

const projectScriptSchema = z.object({ command: z.string(), source: z.enum(['saved', 'detected']) }).nullable()

/**
 * The port a run command binds and how that was found. `fragment` is the text in the run command
 * that sets it; `override` is what to append to move it, {port} standing for the new one, or null.
 */
export const scriptPortSchema = z.object({
  port: z.number().int(),
  framework: z.string().nullable(),
  source: z.enum(['command', 'script', 'env-file', 'package-json', 'default']),
  detail: z.string(),
  fragment: z.string().nullable(),
  override: z.string().nullable(),
})
export type ScriptPort = z.infer<typeof scriptPortSchema>

/** `megabrain repo scripts <root> --json`: a project's run, build and install commands, shared by its worktrees, and the run's port. */
export const projectScriptsSchema = z.object({
  repo: z.string(),
  scripts: z.object({ run: projectScriptSchema, build: projectScriptSchema, install: projectScriptSchema }),
  port: scriptPortSchema.nullable().optional(),
})
export type ProjectScripts = z.infer<typeof projectScriptsSchema>

/** `megabrain repo run --json`: the managed process a project script runs as. `session` is the tmux session to attach a terminal to. */
export const runScriptSchema = z.object({
  script: z.enum(['run', 'build', 'install']),
  session: z.string(),
  pid: z.number().int(),
  alreadyRunning: z.boolean(),
  port: z.number().int().nullable(),
})
export type RunScriptResult = z.infer<typeof runScriptSchema>

/** One process listening on a port (`megabrain port who`), and the megabrain process or app terminal it runs in, if any. */
export const portListenerSchema = z.object({
  pid: z.number().int(),
  command: z.string(),
  args: z.string(),
  cwd: z.string().nullable(),
  startedAt: z.string().nullable(),
  place: z.object({ root: z.string(), project: z.string(), branch: z.string().nullable() }).nullable(),
  managed: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('proc'), name: z.string(), worktree: z.string() }),
      z.object({ kind: z.literal('app-terminal'), session: z.string(), title: z.string() }),
    ])
    .nullable(),
})
export type PortListener = z.infer<typeof portListenerSchema>

/** `megabrain port who <port> --json`. */
export const portListenersSchema = z.object({ port: z.number().int(), listeners: z.array(portListenerSchema) })
export type PortListeners = z.infer<typeof portListenersSchema>

/** `megabrain port free --from <port> --json`. */
export const portFreeSchema = z.object({ port: z.number().int() })

/** `megabrain port kill <port> --json`. */
export const portKillSchema = z.object({ port: z.number().int(), top: z.number().int(), stopped: z.array(z.number().int()), freed: z.boolean() })

/** `megabrain maestro flows --json`: the worktree's flows under .maestro and maestro, path relative to the worktree. */
export const maestroFlowSchema = z.looseObject({ path: z.string(), name: z.string(), appId: z.string().nullable() })
export type MaestroFlow = z.infer<typeof maestroFlowSchema>

const maestroStateSchema = z.enum(['running', 'passed', 'failed', 'stopped'])

/** `megabrain maestro runs --json`: every run of the worktree, newest first; durationMs is null while it runs. */
export const maestroRunSchema = z.looseObject({
  runId: z.string(),
  flow: z.string(),
  device: z.string(),
  state: maestroStateSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().nullable(),
  artifacts: z.string(),
})
export type MaestroRun = z.infer<typeof maestroRunSchema>

/** One line of `megabrain maestro run --json`: the run starting, a finished step, the verdict. */
export const maestroEventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('start'), runId: z.string(), flow: z.string(), device: z.string(), artifacts: z.string() }),
  z.looseObject({
    type: z.literal('step'),
    index: z.number().int(),
    command: z.string(),
    status: z.enum(['passed', 'failed', 'skipped']),
    durationMs: z.number(),
    screenshot: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.looseObject({ type: z.literal('run'), state: maestroStateSchema, runId: z.string(), exitCode: z.number(), durationMs: z.number(), artifacts: z.string() }),
])
export type MaestroEvent = z.infer<typeof maestroEventSchema>

export const simulatorSchema = z.looseObject({ udid: z.string(), name: z.string(), runtime: z.string().optional(), state: z.string(), kind: z.enum(['phone', 'tv']).optional() })
export type Simulator = z.infer<typeof simulatorSchema>

export const simulatorShutdownSchema = z.looseObject({ udid: z.string(), state: z.literal('Shutdown') })
export const simulatorRestartSchema = z.looseObject({ udid: z.string(), state: z.literal('Booted'), waitedMs: z.number() })

/** `megabrain native sim list phone --json`: the available iOS simulators. */
export const simulatorListSchema = z.looseObject({ devices: z.array(simulatorSchema) })

export const simulatorKindSchema = z.enum(['phone', 'tv'])
export type SimulatorKind = z.infer<typeof simulatorKindSchema>

/** One row of `megabrain native sim list --booted --json`: a booted simulator, phone or tv. */
export const bootedSimulatorSchema = z.looseObject({ udid: z.string(), name: z.string(), runtime: z.string(), state: z.string(), kind: simulatorKindSchema })
export type BootedSimulator = z.infer<typeof bootedSimulatorSchema>
export const bootedSimulatorListSchema = z.looseObject({ devices: z.array(bootedSimulatorSchema) })
