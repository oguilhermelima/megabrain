import { useEffect, useRef, useState } from 'react'

// What the Knowledge page's views share: the reading column and a read keyed by an id.

/** The reading column's width: about 720px of text inside its padding. */
export const column = 'mx-auto w-full max-w-[784px] px-8 py-10'

type Loaded<T> = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; value: T }

/** One read for `id`, dropped when the id changes before it answers. */
export function useRead<T>(id: string | null, read: (id: string) => Promise<T>): Loaded<T> {
  const [load, setLoad] = useState<{ id: string | null; value: Loaded<T> }>({ id, value: { state: 'loading' } })
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    if (id === null) return
    let current = true
    latest.current(id).then(
      (value) => current && setLoad({ id, value: { state: 'ready', value } }),
      (error: unknown) => current && setLoad({ id, value: { state: 'failed', error } }),
    )
    return () => {
      current = false
    }
  }, [id])
  return load.id === id ? load.value : { state: 'loading' }
}
