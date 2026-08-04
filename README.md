# docs

Self-hosted collaborative documents + spreadsheets. Go backend, Svelte
frontend (phase 1 currently ships a plain-textarea sync demo). See
`DESIGN-DECISIONS.md` for the architecture and the reasoning behind it.

## Run

    make run          # builds JS bundle + Go binary, listens on 127.0.0.1:8484

Open http://127.0.0.1:8484, sign up, create a document, then open the same
document in a second browser window to see live sync.

## Develop

    make test         # go vet + go test
    make build        # local binary
    ./docs -static web/static   # serve UI from disk instead of the embedded copy

## Deploy

    make release      # dist/docs-linux-arm64, static binary
    make deploy       # on the server: git pull && docker compose up -d --build
