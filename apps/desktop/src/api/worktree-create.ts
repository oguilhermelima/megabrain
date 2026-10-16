import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { CliError, type WorktreeApi } from '@/api/adapter'
import { createWorktreeArgs } from '@/advanced/new-worktree-model'

// `megabrain worktree create --json`: the new worktree's path and branch, among other fields.
export const createdWorktreeSchema = z.looseObject({ worktree: z.string(), branch: z.string() })

interface CliOutput {
  code: number | null
  stdout: string
  stderr: string
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

export function tauriWorktreeApi(): WorktreeApi {
  return {
    async createWorktree(repo, branch, base) {
      const output = await invoke<CliOutput>('run_cli', { args: createWorktreeArgs(repo, branch, base) })
      if (output.code !== 0 || output.stdout.trim() === '') throw new CliError(lastLine(output.stderr) || lastLine(output.stdout) || `megabrain worktree create exited ${output.code}`, output.code)
      const parsed = createdWorktreeSchema.safeParse(JSON.parse(output.stdout))
      if (!parsed.success) throw new CliError(`megabrain worktree create answered in an unexpected shape: ${parsed.error.message}`, output.code)
      return { path: parsed.data.worktree, branch: parsed.data.branch }
    },
  }
}

/** The browser preview: a short wait, then a folder beside the project; the mock projects list never shows it. */
export function mockWorktreeApi(): WorktreeApi {
  return {
    createWorktree: (repo, branch) =>
      new Promise((resolve) => setTimeout(() => resolve({ path: `${repo}-worktrees/${branch.replaceAll('/', '-')}`, branch }), 900)),
  }
}
