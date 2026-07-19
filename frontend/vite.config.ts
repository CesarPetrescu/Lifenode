import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/@mui/icons-material/')) return 'mui-icons'
          if (
            id.includes('/@mui/')
            || id.includes('/@emotion/')
            || id.includes('/@popperjs/')
          ) {
            return 'mui-core'
          }
          if (
            id.includes('/react/')
            || id.includes('/react-dom/')
            || id.includes('/scheduler/')
          ) {
            return 'react-vendor'
          }
          return undefined
        },
      },
    },
  },
})
