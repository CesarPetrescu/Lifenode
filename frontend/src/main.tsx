import { createContext, StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import App from './App.tsx'
import './index.css'

export const ColorModeContext = createContext({
  toggleColorMode: () => {},
  mode: 'light' as 'light' | 'dark',
})

function AppWithTheme() {
  const stored = localStorage.getItem('lifenode_theme')
  const initial: 'light' | 'dark' = stored === 'dark' ? 'dark' : 'light'
  const [mode, setMode] = useState<'light' | 'dark'>(initial)

  const colorMode = useMemo(
    () => ({
      toggleColorMode: () => {
        setMode((prev) => {
          const next = prev === 'light' ? 'dark' : 'light'
          localStorage.setItem('lifenode_theme', next)
          return next
        })
      },
      mode,
    }),
    [mode],
  )

  const theme = useMemo(
    () =>
      createTheme({
        palette:
          mode === 'light'
            ? {
                mode: 'light',
                primary: { main: '#1144cc' },
                secondary: { main: '#0f766e' },
                background: { default: '#f6f8ff', paper: '#ffffff' },
              }
            : {
                mode: 'dark',
                primary: { main: '#5b8def' },
                secondary: { main: '#2dd4bf' },
                background: { default: '#0f1117', paper: '#1a1d27' },
              },
        shape: { borderRadius: 12 },
        typography: {
          fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
        },
        components: {
          MuiCard: {
            styleOverrides: {
              root: { backgroundImage: 'none' },
            },
          },
          MuiButton: {
            styleOverrides: {
              root: {
                textTransform: 'none',
                minHeight: 36,
              },
            },
          },
          MuiIconButton: {
            styleOverrides: {
              root: {
                minWidth: 36,
                minHeight: 36,
              },
            },
          },
          MuiInputBase: {
            styleOverrides: {
              input: {
                fontSize: '1rem',
              },
            },
          },
        },
      }),
    [mode],
  )

  useEffect(() => {
    document.documentElement.style.colorScheme = mode
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    const nextColor = mode === 'dark' ? '#0f1117' : '#f6f8ff'
    if (themeMeta) {
      themeMeta.setAttribute('content', nextColor)
    }
  }, [mode])

  return (
    <ColorModeContext.Provider value={colorMode}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </ColorModeContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppWithTheme />
  </StrictMode>,
)
