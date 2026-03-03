import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import App from './App.tsx'
import './index.css'

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1144cc' },
    secondary: { main: '#0f766e' },
    background: {
      default: '#f6f8ff',
      paper: '#ffffff',
    },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
)
