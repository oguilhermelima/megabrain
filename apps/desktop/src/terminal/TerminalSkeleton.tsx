import { Spinner } from '@/components/ui'

const lines = ['w-[46%]', 'w-[72%]', 'w-[30%]', 'w-[58%]']

/** A terminal that is not open yet: what is starting, over a few faint prompt lines where its output will be. */
export function TerminalSkeleton({ label = 'Starting the terminal' }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="mx-4 my-3 flex min-h-0 flex-1 flex-col gap-2.5 px-1 pt-1">
      <p className="flex items-center gap-2 text-[12.5px] text-ink-400">
        <Spinner />
        {label}…
      </p>
      {lines.map((width) => (
        <span key={width} aria-hidden="true" className={`h-3 ${width} animate-pulse rounded-full bg-white/[0.05] motion-reduce:animate-none`} />
      ))}
    </div>
  )
}
