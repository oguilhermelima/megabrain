import { z } from 'zod'

// What the app reads from the megabrain CLI. Each schema names only the fields the app uses and lets
// the rest through, so a new CLI field never breaks the app while a missing or renamed one shows up
// as a parse error at the boundary instead of an empty screen.

const agentSchema = z.looseObject({
  agent: z.string(),
  label: z.string(),
  installed: z.boolean(),
  configDir: z.string().nullable(),
})

const hostsSchema = z.looseObject({ orca: z.boolean(), superset: z.boolean(), tmux: z.boolean() })
const skillSchema = z.enum(['none', 'global', 'project'])
const yesNoSchema = z.enum(['yes', 'no'])

export const installPlanSchema = z.looseObject({
  version: z.string(),
  hosts: hostsSchema,
  agents: z.array(agentSchema),
  modules: z.array(
    z.looseObject({
      module: z.string(),
      label: z.string(),
      hint: z.string(),
      group: z.string(),
      selectedByDefault: z.boolean(),
      unavailable: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  defaults: z.looseObject({ agents: z.array(z.string()), skill: skillSchema, tmux: yesNoSchema, modules: z.array(z.string()) }),
  previous: z
    .looseObject({ agents: z.array(z.string()), skill: skillSchema, tmux: yesNoSchema, modules: z.array(z.string()) })
    .nullable(),
})

export const installEventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('intro'), version: z.string(), hosts: hostsSchema, agents: z.array(agentSchema) }),
  z.looseObject({
    type: z.literal('step'),
    module: z.string().optional(),
    label: z.string(),
    state: z.enum(['start', 'done', 'fail']),
    message: z.string().optional(),
  }),
  z.looseObject({ type: z.literal('info'), message: z.string() }),
  z.looseObject({ type: z.literal('warn'), message: z.string() }),
  z.looseObject({ type: z.literal('confirm'), message: z.string(), answer: z.boolean() }),
  z.looseObject({
    type: z.literal('result'),
    ok: z.boolean(),
    message: z.string(),
    configured: z.array(z.string()),
    failed: z.array(z.looseObject({ module: z.string(), message: z.string() })),
  }),
])

export const moduleResultSchema = z.looseObject({ module: z.string(), action: z.string(), ok: z.boolean(), message: z.string() })

export const doctorReportSchema = z.array(z.looseObject({ module: z.string(), status: z.string(), reason: z.string() }))

const findingSchema = z.looseObject({
  cause: z.string(),
  resetAt: z.string().optional(),
  errorText: z.string().optional(),
  lastLines: z.string().optional(),
  recommendation: z.string().optional(),
})

const dispatchSchema = z.looseObject({
  dispatchId: z.string(),
  state: z.string(),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  chatName: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  owner: z.enum(['mine', 'foreign', 'unknown']),
  parentSessionId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  supervision: z.object({ lastCheck: z.string().nullable(), finding: findingSchema.nullable() }),
})

export const statusSchema = z.looseObject({
  generatedAt: z.string(),
  context: z.looseObject({ host: z.string() }).nullable(),
  machine: z
    .looseObject({
      totalMemoryBytes: z.number(),
      availableMemoryBytes: z.number(),
      pressure: z.string(),
      swapUsedBytes: z.number(),
      loadAverage1: z.number(),
      cpuCount: z.number(),
    })
    .nullable(),
  supervisor: z.object({ watcher: z.object({ running: z.boolean(), pid: z.number().nullable() }) }),
  dispatches: z.array(dispatchSchema),
  queue: z.array(
    z.looseObject({ id: z.string(), kind: z.string(), dispatch: z.string(), type: z.string(), createdAt: z.string(), state: z.string(), text: z.string() }),
  ),
  processes: z.array(z.looseObject({ name: z.string() })),
  resources: z.object({ history: z.boolean(), admission: z.looseObject({}).nullable() }),
  deliveryChannels: z.array(z.looseObject({ agent: z.string(), channel: z.string(), status: z.string() })),
})

export const worktreeListSchema = z.array(
  z.looseObject({
    path: z.string(),
    branch: z.string(),
    repository: z.looseObject({ name: z.string(), path: z.string() }).optional(),
  }),
)

export const chatReadSchema = z.looseObject({ dispatchId: z.string(), source: z.string(), truncated: z.boolean(), text: z.string() })

export const replyResultSchema = z.looseObject({ dispatchId: z.string(), status: z.string(), nudge: z.string() })

export type InstallPlan = z.infer<typeof installPlanSchema>
export type PlanModule = InstallPlan['modules'][number]
export type InstallEvent = z.infer<typeof installEventSchema>
export type ResultEvent = Extract<InstallEvent, { type: 'result' }>
export type ModuleResult = z.infer<typeof moduleResultSchema>
export type DoctorReport = z.infer<typeof doctorReportSchema>
export type Status = z.infer<typeof statusSchema>
export type Dispatch = Status['dispatches'][number]
export type Worktree = z.infer<typeof worktreeListSchema>[number]
export type ChatRead = z.infer<typeof chatReadSchema>
export type ReplyResult = z.infer<typeof replyResultSchema>
