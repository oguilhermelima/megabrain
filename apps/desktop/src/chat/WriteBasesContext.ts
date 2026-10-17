import { createContext } from 'react'

const noBases = new Map<string, string>()

/** For each Write over a file the chat wrote before, the content it replaced (see writeBases). */
export const WriteBasesContext = createContext<ReadonlyMap<string, string>>(noBases)
