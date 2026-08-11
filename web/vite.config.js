import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  build: {
    // Output goes where the Go binary embeds from. emptyOutDir is off so
    // static/.gitkeep survives (it keeps the embed path present on a fresh
    // clone); the Makefile js target clears old hashed assets instead.
    outDir: 'static',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        // Split the dependencies out from our own code. Everything is
        // still loaded on every page, so this saves no bytes on a first
        // visit — what it saves is REPEAT deploys. Assets are hashed and
        // served immutable, so with one bundle a one-line change to our
        // code re-hashes all of it and every client re-downloads
        // CodeMirror (170 kB gzipped, ~70% of the bundle). Split out, a
        // code-only deploy leaves the vendor chunks cached.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // Code-block grammars must NOT be named here. @codemirror/language-data
          // reaches them through dynamic import(), so Rollup would otherwise
          // split them out and load one only when a fenced block asks for it —
          // but naming a chunk overrides that, and all ~130 of them would land
          // in the eagerly-loaded editor chunk. Returning undefined leaves the
          // lazy boundary intact.
          if (/@codemirror\/(lang-|legacy-modes)|@lezer\/(?!common|highlight|markdown)/.test(id)) return
          if (id.includes('codemirror') || id.includes('lezer')) return 'vendor-editor'
          if (/yjs|y-protocols|y-codemirror|lib0/.test(id)) return 'vendor-sync'
          return 'vendor'
        },
      },
    },
  },
  server: {
    // `npm run dev` gives hot reload for shell work; API and websocket
    // traffic proxies to the Go server, which must also be running and be
    // started with -allow-origin http://localhost:5173 for the websocket
    // origin check to pass.
    proxy: {
      '/api': 'http://127.0.0.1:8484',
      '/ws': { target: 'ws://127.0.0.1:8484', ws: true },
    },
  },
})
