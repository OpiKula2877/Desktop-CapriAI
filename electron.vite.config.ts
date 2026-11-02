import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pages = ['overlay', 'avatar', 'settings', 'meltdown', 'cursor', 'stage', 'paint']

export default defineConfig({
  main: {
    build: { externalizeDeps: true }
  },
  preload: {
    build: { externalizeDeps: true }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: Object.fromEntries(pages.map((p) => [p, resolve(__dirname, `src/renderer/${p}.html`)]))
      }
    }
  }
})
