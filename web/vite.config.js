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
