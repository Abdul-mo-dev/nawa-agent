import { createContext } from 'react'

/** Chat retains ownership of its actions while the panel supplies their placement. */
export const ChatHeaderTarget = createContext<HTMLElement | null>(null)
