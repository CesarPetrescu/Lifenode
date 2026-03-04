import { createContext } from 'react'

export type ColorMode = 'light' | 'dark'

export const ColorModeContext = createContext({
  toggleColorMode: () => {},
  mode: 'light' as ColorMode,
})
