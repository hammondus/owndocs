# docs

Self-hosted collaborative documents + spreadsheets. Go backend, Svelte 5
frontend, markdown-native editor over CodeMirror 6 + Yjs. See
`DESIGN-DECISIONS.md` for the architecture and the reasoning behind it.

## Run

    make run          # builds frontend + Go binary, listens on 127.0.0.1:8484

Open http://127.0.0.1:8484, sign up, create a document, then open the same
document in a second browser window to see live sync. Share docs from the
list or the editor's share link. `-signup=closed` disables new accounts.

## Develop

    make test         # go vet + go test
    make build        # frontend build + local binary

Frontend hot-reload loop: run the Go server with
`./docs -allow-origin http://localhost:5173`, then `cd web && npm run dev`
and use http://localhost:5173 (API and websockets proxy through vite).
End-to-end sync check (needs a running server): `cd web && node scripts/e2e.mjs`

## Deploy

    make release      # dist/docs-linux-arm64, static binary
    make deploy       # on the server: git pull && docker compose up -d --build
