import { Channel, invoke } from '@tauri-apps/api/core'
import { CliError, type OrchestrationApi } from '@/api/adapter'
import { streamMarkerSchema } from '@/api/chat-stream'
import { fixtureGraph, fixtureLiveEvents } from '@/native-chat/orchestration/orchestration-fixture'
import { orchestrationGraphSchema, orchestrationMessageTypeSchema, type OrchestrationGraph, type OrchestrationTarget } from '@/native-chat/orchestration/orchestration-schema'

// STUB until the CLI lane merges `megabrain orchestrate graph`: the browser preview answers from the
// fixture, and the app calls the command to the shared contract. Reconciled with the real adapter at merge.

interface CliOutput {
  code: number | null
  stdout: string
  stderr: string
}

const targetArgs = (target: OrchestrationTarget): string[] => ('chat' in target ? ['--chat', target.chat] : ['--session', target.session])

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

export function tauriOrchestrationApi(): OrchestrationApi {
  return {
    async orchestrationGraph(target) {
      const output = await invoke<CliOutput>('run_cli', { args: ['orchestrate', 'graph', ...targetArgs(target), '--json'] })
      if (output.code !== 0 || output.stdout.trim() === '') throw new CliError(firstLine(output.stderr) || `megabrain orchestrate graph exited ${output.code}`, output.code)
      const parsed = orchestrationGraphSchema.safeParse(JSON.parse(output.stdout))
      if (!parsed.success) throw new CliError(`megabrain orchestrate graph answered in an unexpected shape: ${parsed.error.message}`, output.code)
      return parsed.data
    },
    async followOrchestration(target, onGraph, onEnd) {
      let error: string | null = null
      const channel = new Channel<string>()
      // Every line is a full snapshot; a line that fails is reported and the next one is read, since a
      // handler that throws would hold back every later message on the channel.
      channel.onmessage = (line) => {
        try {
          const value: unknown = JSON.parse(line)
          const marker = streamMarkerSchema.safeParse(value)
          if (marker.success && marker.data.end === true) return onEnd?.(error)
          if (marker.success && marker.data.error !== undefined) {
            error = marker.data.error
            return
          }
          onGraph(orchestrationGraphSchema.parse(value))
        } catch (caught) {
          console.error(caught)
        }
      }
      const streamId = await invoke<string>('cli_stream', { args: ['orchestrate', 'graph', ...targetArgs(target), '--follow', '--json'], onLine: channel })
      return () => void invoke('cli_stream_stop', { streamId })
    },
  }
}

function mockFocus(target: OrchestrationTarget): string | null {
  const graph = fixtureGraph(null)
  const node = graph.nodes.find((entry) => ('chat' in target ? entry.chatId === target.chat : entry.session === target.session))
  return node?.id ?? null
}

/** The fixture's next snapshot after one live event: the event joins the log and becomes its node's last message. */
export function withLiveEvent(graph: OrchestrationGraph, event: OrchestrationGraph['events'][number]): OrchestrationGraph {
  const nodes = graph.nodes.map((node) => {
    if (node.id !== event.node) return node
    const type = orchestrationMessageTypeSchema.safeParse(event.type)
    const last = type.success ? { type: type.data, text: event.text, at: event.at } : node.last
    if (event.type === 'ask') return { ...node, state: 'asking' as const, unanswered: true, last }
    if (event.type === 'reply') return { ...node, state: 'working' as const, unanswered: false, last }
    if (event.type === 'done') return { ...node, state: 'done' as const, endedAt: event.at, last }
    return { ...node, last }
  })
  return { ...graph, nodes, events: [...graph.events, event].slice(-200) }
}

/** The browser preview: the fixture, and in dev a fixture event every few seconds so the live path animates. */
export function mockOrchestrationApi(): OrchestrationApi {
  return {
    orchestrationGraph: async (target) => fixtureGraph(mockFocus(target)),
    async followOrchestration(target, onGraph) {
      let graph = fixtureGraph(mockFocus(target))
      onGraph(graph)
      if (!import.meta.env.DEV) return () => {}
      let next = 0
      const timer = setInterval(() => {
        const live = fixtureLiveEvents[next % fixtureLiveEvents.length]
        next += 1
        if (live === undefined) return
        graph = withLiveEvent(graph, { ...live, at: new Date().toISOString() })
        onGraph(graph)
      }, 5_000)
      return () => clearInterval(timer)
    },
  }
}
