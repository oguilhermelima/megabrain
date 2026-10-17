import { z } from 'zod'

// Artifacts: diagrams, plans and docs agents file per project (`artifact list|show --json`). A diagram
// is HTML; a plan or doc is HTML or Markdown. `path` is the content file under the state directory.
export const artifactSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['diagram', 'plan', 'doc']),
  format: z.enum(['html', 'markdown']),
  /** The repository's main checkout path, its folder name, and its knowledge folder. */
  project: z.string(),
  projectName: z.string(),
  projectId: z.string(),
  topics: z.array(z.string()),
  chatId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number(),
  path: z.string(),
})
export const artifactListSchema = z.looseObject({ artifacts: z.array(artifactSchema) })
// `show` also names the versions its updates replaced, oldest first, without their content; a megabrain
// before that lists none.
export const artifactRevisionSchema = z.looseObject({ revision: z.number(), title: z.string(), updatedAt: z.string(), replacedAt: z.string() })
export const artifactContentSchema = artifactSchema.extend({ content: z.string(), revisions: z.array(artifactRevisionSchema).optional() })
// A native chat's artifacts (`chat artifacts <chat-id> --json`): what megabrain filed for it and what
// its agent made elsewhere (a Claude artifact or Claude Design project, a Codex plan, agy's or Grok's),
// newest first with stable ids. A url-only artifact has no content to read; `revision` is null when the
// source keeps none.
export const chatArtifactSchema = z.looseObject({
  id: z.string(),
  source: z.enum(['megabrain', 'claude-artifact', 'claude-design', 'codex-plan', 'agy', 'grok']),
  title: z.string(),
  format: z.enum(['html', 'markdown', 'text', 'url']),
  path: z.string().optional(),
  url: z.string().optional(),
  updatedAt: z.string(),
  revision: z.number().nullable(),
  editable: z.boolean(),
})
export const chatArtifactListSchema = z.looseObject({ artifacts: z.array(chatArtifactSchema) })
// `chat artifact <chat-id> <artifact-id> --json`: content is null when there is none to read, and `reason` says why.
export const chatArtifactContentSchema = z.looseObject({ artifact: chatArtifactSchema, content: z.string().nullable(), updatedAt: z.string(), reason: z.string().optional() })
// A pending approval inside a native chat; it arrives as a transcript event of kind "approval".
export type Artifact = z.infer<typeof artifactSchema>
export type ArtifactKind = Artifact['kind']
export type ArtifactList = z.infer<typeof artifactListSchema>
export type ArtifactContent = z.infer<typeof artifactContentSchema>
export type ArtifactRevision = z.infer<typeof artifactRevisionSchema>
export type ChatArtifact = z.infer<typeof chatArtifactSchema>
export type ChatArtifactSource = ChatArtifact['source']
export type ChatArtifactList = z.infer<typeof chatArtifactListSchema>
export type ChatArtifactContent = z.infer<typeof chatArtifactContentSchema>
