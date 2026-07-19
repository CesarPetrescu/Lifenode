import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { alpha, responsiveFontSizes } from '@mui/material/styles'
import App from './App.tsx'
import { ColorModeContext, type ColorMode } from './themeContext'
import './index.css'

export function AppWithTheme() {
  const stored = localStorage.getItem('lifenode_theme')
  const initial: ColorMode = stored === 'dark' ? 'dark' : 'light'
  const [mode, setMode] = useState<ColorMode>(initial)

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
    () => {
      const paletteTokens = mode === 'light'
        ? {
            primary: '#1d4ed8',
            secondary: '#0f766e',
            background: '#f5f1e8',
            paper: '#fffdf9',
            surface: '#f8f4eb',
            text: '#142033',
            textSoft: '#5a6477',
            accent: '#c2410c',
          }
        : {
            primary: '#7aa2ff',
            secondary: '#4fd1c5',
            background: '#0d131d',
            paper: '#131c28',
            surface: '#182230',
            text: '#eef3ff',
            textSoft: '#a7b4cb',
            accent: '#fb923c',
          }

      let theme = createTheme({
        palette:
          mode === 'light'
            ? {
                mode: 'light',
                primary: { main: paletteTokens.primary },
                secondary: { main: paletteTokens.secondary },
                success: { main: '#0f766e' },
                warning: { main: '#b45309' },
                background: { default: paletteTokens.background, paper: paletteTokens.paper },
                text: { primary: paletteTokens.text, secondary: paletteTokens.textSoft },
                divider: alpha(paletteTokens.text, 0.1),
              }
            : {
                mode: 'dark',
                primary: { main: paletteTokens.primary },
                secondary: { main: paletteTokens.secondary },
                success: { main: '#22c55e' },
                warning: { main: '#f59e0b' },
                background: { default: paletteTokens.background, paper: paletteTokens.paper },
                text: { primary: paletteTokens.text, secondary: paletteTokens.textSoft },
                divider: alpha(paletteTokens.text, 0.14),
              },
        shape: { borderRadius: 18 },
        typography: {
          fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
          h1: { fontWeight: 700, letterSpacing: '-0.04em' },
          h2: { fontWeight: 700, letterSpacing: '-0.04em' },
          h3: { fontWeight: 700, letterSpacing: '-0.035em' },
          h4: { fontWeight: 700, letterSpacing: '-0.03em' },
          h5: { fontWeight: 700, letterSpacing: '-0.025em' },
          h6: { fontWeight: 700, letterSpacing: '-0.02em' },
          subtitle1: { fontWeight: 600, letterSpacing: '-0.015em' },
          subtitle2: { fontWeight: 600, letterSpacing: '-0.01em' },
          button: { fontWeight: 700, letterSpacing: '-0.01em' },
          overline: {
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          },
        },
        components: {
          MuiCssBaseline: {
            styleOverrides: {
              body: {
                backgroundColor: paletteTokens.background,
                backgroundImage:
                  mode === 'light'
                    ? 'radial-gradient(circle at 0% 0%, rgba(29,78,216,0.11), transparent 28%), radial-gradient(circle at 85% 12%, rgba(194,65,12,0.09), transparent 24%), linear-gradient(180deg, rgba(255,255,255,0.58), rgba(245,241,232,0.98))'
                    : 'radial-gradient(circle at 0% 0%, rgba(122,162,255,0.18), transparent 28%), radial-gradient(circle at 85% 12%, rgba(79,209,197,0.15), transparent 24%), linear-gradient(180deg, rgba(13,19,29,0.96), rgba(13,19,29,1))',
                color: paletteTokens.text,
              },
              '#root': {
                minHeight: '100dvh',
              },
            },
          },
          MuiPaper: {
            styleOverrides: {
              root: {
                backgroundImage: 'none',
              },
              outlined: {
                borderColor: alpha(paletteTokens.text, mode === 'light' ? 0.08 : 0.16),
              },
            },
          },
          MuiCard: {
            styleOverrides: {
              root: {
                backgroundImage: 'none',
                border: `1px solid ${alpha(paletteTokens.text, mode === 'light' ? 0.08 : 0.16)}`,
                boxShadow:
                  mode === 'light'
                    ? '0 18px 48px rgba(20, 32, 51, 0.08)'
                    : '0 22px 58px rgba(0, 0, 0, 0.34)',
              },
            },
          },
          MuiButton: {
            defaultProps: {
              disableElevation: true,
            },
            styleOverrides: {
              root: {
                textTransform: 'none',
                minHeight: 40,
                borderRadius: 999,
                paddingInline: 18,
              },
              containedPrimary: {
                boxShadow:
                  mode === 'light'
                    ? '0 12px 28px rgba(29, 78, 216, 0.22)'
                    : '0 14px 32px rgba(45, 84, 198, 0.28)',
              },
            },
          },
          MuiChip: {
            styleOverrides: {
              root: {
                borderRadius: 999,
                fontWeight: 600,
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
          MuiTabs: {
            styleOverrides: {
              indicator: {
                height: 3,
                borderRadius: 999,
              },
            },
          },
          MuiTab: {
            styleOverrides: {
              root: {
                textTransform: 'none',
                fontWeight: 600,
                minHeight: 44,
              },
            },
          },
          MuiOutlinedInput: {
            styleOverrides: {
              root: {
                borderRadius: 16,
                backgroundColor: alpha(paletteTokens.surface, mode === 'light' ? 0.78 : 0.88),
                transition: 'box-shadow 0.2s ease, border-color 0.2s ease, background-color 0.2s ease',
                '&:hover .MuiOutlinedInput-notchedOutline': {
                  borderColor: alpha(paletteTokens.primary, 0.48),
                },
                '&.Mui-focused': {
                  boxShadow: `0 0 0 4px ${alpha(paletteTokens.primary, 0.16)}`,
                },
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
          MuiAlert: {
            styleOverrides: {
              root: {
                borderRadius: 16,
              },
            },
          },
        },
      })

      theme = responsiveFontSizes(theme)
      return theme
    },
    [mode],
  )

  useEffect(() => {
    document.documentElement.style.colorScheme = mode
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    const nextColor = mode === 'dark' ? '#0d131d' : '#f5f1e8'
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
