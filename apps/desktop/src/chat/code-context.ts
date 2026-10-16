import { createContext, useContext } from 'react'

/** Opens a worktree or folder in Code mode, the embedded VS Code; null where Code cannot open. */
export const OpenCodeContext = createContext<((root: string) => void) | null>(null)

export const useOpenCode = () => useContext(OpenCodeContext)
