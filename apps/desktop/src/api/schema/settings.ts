import { z } from 'zod'

// `megabrain settings --json`: everything the Settings window shows, in one read. Writes go through
// the existing verbs (resources policy set|off, resources enable|disable, supervise, chain limits
// --notice-on|--notice-off|--notice-interval|--enable|--disable, chain save|delete, model refresh,
// terminal default) and the window re-reads settings afterwards.
// A chain's `when` and a step's `when` are rules (chains.json, backward compatible): a Condition, whose
// fields must all hold and each take one value or a list meaning any of them, or {all}, {any} or {not}
// of further rules. The app reads them loosely; the CLI (chain save --dry-run) is the authority on
// whether one is valid, and settings/chain-rules.ts checks the grammar locally for instant feedback.
export type RuleValues = string | string[]
export interface UsageCondition {
  provider: string
  window: '5h' | 'weekly'
  below?: number
  above?: number
}
export interface TimeCondition {
  /** mon, tue, wed, thu, fri, sat, sun. */
  days?: string[]
  /** Local time, HH:MM. */
  from?: string
  to?: string
}
export interface Condition {
  parentAgent?: RuleValues
  parentModel?: RuleValues
  parentEffort?: RuleValues
  /** Repository name or path; a glob. */
  repo?: RuleValues
  branch?: RuleValues
  /** A glob on the dispatch label. */
  label?: RuleValues
  usage?: UsageCondition
  time?: TimeCondition
}
export type Rule = Condition | { all: Rule[] } | { any: Rule[] } | { not: Rule }
const ruleSchema = z.custom<Rule>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'expected a rule object')

export const chainStepSchema = z.looseObject({
  agent: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  until: z.looseObject({ usedPercent: z.number(), window: z.string() }).optional(),
  /** The step is skipped unless this rule matches. */
  when: ruleSchema.optional(),
  /** Set by `settings --json` when the model is no longer in the registry; never saved back. */
  stale: z.boolean().optional(),
  reason: z.string().optional(),
  suggested: z.looseObject({ model: z.string(), effort: z.string().optional() }).nullable().optional(),
})
export const chainSchema = z.looseObject({
  name: z.string(),
  when: ruleSchema,
  steps: z.array(chainStepSchema),
  /** Higher wins among matching chains; absent means 0. */
  priority: z.number().optional(),
})
// `chain explain --json`: every chain with whether it matched and why, the chosen one, and its steps.
// Step indexes are 1-based on the command line; the adapter turns them into array positions.
export const chainExplainSchema = z.looseObject({
  candidates: z.array(
    z.looseObject({
      name: z.string(),
      matched: z.boolean(),
      specificity: z.number(),
      priority: z.number(),
      reasons: z.union([z.string().transform((reason) => [reason]), z.array(z.string())]),
    }),
  ),
  chosen: z.string().nullable(),
  steps: z.array(z.looseObject({ index: z.number(), step: chainStepSchema, skipped: z.boolean(), reason: z.string().nullable().optional() })),
})
// `chain save ... --dry-run --json`: exit 0 when ok, 2 when invalid, nothing written either way.
export const chainValidationSchema = z.looseObject({
  ok: z.boolean(),
  errors: z.array(z.looseObject({ path: z.string(), message: z.string() })),
})
export const usageReadingSchema = z.looseObject({
  provider: z.string(),
  window: z.string(),
  bucket: z.string().nullable().optional(),
  status: z.string(),
  usedPercent: z.number().nullable(),
  /** Unix seconds as a string, as chain limits reports it. */
  resetsAt: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  reason: z.string(),
  /** Unix seconds of the next live attempt, when the status is stale; absent from an older CLI. */
  retryAt: z.number().nullable().optional(),
  /** Where the reading came from: disk, cache or live. */
  source: z.string().optional(),
  /** Set when the value is the last one known rather than a current reading, with why. */
  stale: z.boolean().optional(),
  staleReason: z.string().optional(),
})
export const settingsSchema = z.looseObject({
  /** Engine for embedded terminals; absent means native. */
  terminalEngine: z.enum(['native', 'tmux']).optional(),
  /** Most recent checks and attempts by agent. */
  agents: z.looseObject({
    updates: z.record(z.string(), z.looseObject({
      agent: z.string(), installed: z.string().nullable(), latest: z.string().nullable(),
      installKind: z.string(), status: z.string(), checkedAt: z.string(),
      lastAttempt: z.looseObject({ at: z.string(), ok: z.boolean(), error: z.string().optional() }).optional(),
    })),
  }).optional(),
  supervisor: z.looseObject({ running: z.boolean(), pid: z.number().nullable() }),
  resources: z.looseObject({
    historyEnabled: z.boolean(),
    /** null when no admission policy is set. */
    policy: z
      .looseObject({
        maxAgents: z.number().nullable(),
        minAvailableMib: z.number().nullable(),
        maxPressure: z.enum(['normal', 'elevated']).nullable(),
        maxContainerSuites: z.number().nullable(),
      })
      .nullable(),
  }),
  limits: z.looseObject({
    /** Providers whose live usage reading is enabled. */
    enabledProviders: z.array(z.string()),
    notice: z.looseObject({ enabled: z.boolean(), intervalSeconds: z.number() }),
    readings: z.array(usageReadingSchema),
  }),
  chains: z.array(chainSchema),
  models: z.array(
    z.looseObject({
      agent: z.string(),
      model: z.string(),
      /** The levels the model accepts and the one it runs at when none is given (null when unknown). */
      reasoning: z.looseObject({ levels: z.array(z.string()), default: z.string().nullable().optional() }),
      /** How people say the model, for example Opus 5.5; absent from an older CLI. */
      name: z.string().optional(),
      /** The line within an agent (opus, sol, gemini flash) and its version (5.5); null when unknown. */
      family: z.string().nullable().optional(),
      generation: z.string().nullable().optional(),
      /** Token windows the model supports, the default first; absent from an older CLI. */
      contextWindows: z.array(z.number()).optional(),
      /** current, older or deprecated; an older CLI said active or retired, or nothing. */
      status: z.string().optional(),
      /** What the model is best for, one line for a person choosing; null or absent when unknown. */
      description: z.string().nullable().optional(),
      /** Whether the picker offers it, after Settings > Models; absent from an older CLI, which means on. */
      enabled: z.boolean().optional(),
    }),
  ),
  terminal: z.looseObject({ default: z.string().nullable(), detected: z.string().nullable(), available: z.array(z.string()) }),
})

export const agentUpdateReportSchema = z.looseObject({
  agent: z.enum(['codex', 'claude', 'grok', 'agy']),
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  installKind: z.enum(['standalone', 'npm', 'brew', 'native', 'unknown']),
  status: z.enum(['up-to-date', 'update-available', 'updating', 'updated', 'latest-unknown', 'failed']),
  checkedAt: z.string(),
  lastAttempt: z.looseObject({ at: z.string(), ok: z.boolean(), error: z.string().optional() }).optional(),
})

export const agentAutoUpdateSettingsSchema = z.looseObject({
  enabled: z.boolean(),
  perAgent: z.record(z.string(), z.boolean()),
})

const tokenKinds = { input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), reasoning: z.number() }

/** `usage stats --json`: token usage per day and provider from the agents' own logs. */
export const usageStatsSchema = z.looseObject({
  range: z.looseObject({ days: z.number().nullable(), from: z.string().nullable(), to: z.string() }),
  prices: z.looseObject({ asOf: z.string(), note: z.string() }),
  totals: z.looseObject({ ...tokenKinds, total: z.number(), sessions: z.number(), turns: z.number(), cost: z.number().nullable(), unpricedTokens: z.number() }),
  daily: z.array(z.looseObject({ date: z.string(), total: z.number(), byProvider: z.record(z.string(), z.number()) })),
  activeDays: z.number(),
  bestDay: z.looseObject({ date: z.string(), total: z.number() }).nullable(),
  cacheShare: z.number().nullable(),
  trackingSince: z.string().nullable(),
  providers: z.array(
    z.looseObject({
      provider: z.string(),
      tracked: z.boolean(),
      ...tokenKinds,
      total: z.number(),
      sessions: z.number(),
      turns: z.number(),
      cost: z.number().nullable(),
      unpricedTokens: z.number(),
      share: z.number(),
      lastModel: z.string().nullable(),
      lastProject: z.string().nullable(),
      lastActiveAt: z.string().nullable(),
    }),
  ),
  models: z.array(z.looseObject({ provider: z.string(), model: z.string(), total: z.number(), cost: z.number().nullable() })),
  projects: z.array(z.looseObject({ project: z.string(), total: z.number() })),
  megabrain: z.looseObject({ dispatches: z.number(), agentSeconds: z.number(), chats: z.number(), since: z.string().nullable() }).nullable(),
})
export type UsageStats = z.infer<typeof usageStatsSchema>
export type Settings = z.infer<typeof settingsSchema>
export type AgentUpdateReport = z.infer<typeof agentUpdateReportSchema>
export type AgentUpdateId = AgentUpdateReport['agent']
export type AgentAutoUpdateSettings = z.infer<typeof agentAutoUpdateSettingsSchema>
/** The top-level keys of `settings --json`; `--only` reads some of them. */
export type SettingsKey = 'terminalEngine' | 'supervisor' | 'resources' | 'limits' | 'chains' | 'models' | 'terminal' | 'agents'
export type Chain = z.infer<typeof chainSchema>
export type ChainStep = z.infer<typeof chainStepSchema>
export type ChainExplain = z.infer<typeof chainExplainSchema>
export type ChainValidation = z.infer<typeof chainValidationSchema>
/** A chain as chains.json stores it, without its name. */
export interface ChainBody {
  when: Rule
  steps: ChainStep[]
  priority?: number
}
/** The dispatch `chain explain` imagines; every field optional. */
export interface ChainExplainInput {
  parentAgent?: string
  parentModel?: string
  parentEffort?: string
  repo?: string
  branch?: string
  label?: string
}
/** One step's changes for `chain step edit`; null removes until or when. */
export interface StepPatch {
  agent?: string
  model?: string
  effort?: string
  until?: ChainStep['until'] | null
  when?: Rule | null
}
export type UsageReading = z.infer<typeof usageReadingSchema>

export interface AdmissionPolicy {
  maxAgents?: number
  minAvailableMib?: number
  maxPressure?: 'normal' | 'elevated'
  maxContainerSuites?: number
}
