# docs

Self-hosted collaborative documents + spreadsheets. Go backend, Svelte 5
frontend, markdown-native editor over CodeMirror 6 + Yjs. See
`DESIGN-DECISIONS.md` for the architecture and the reasoning behind it, and
`ROADMAP.md` for what is decided but not yet built.

## Run

    make run          # builds frontend + Go binary, listens on 127.0.0.1:8484

Open http://127.0.0.1:8484, sign up, create a document, then open the same
document in a second browser window to see live sync. Share docs from the
list or the editor's share link. `-signup=closed` disables new accounts.

## Develop

    make test         # go vet + go test + the headless JS suites
    make test-ui      # drives the real UI in a real Chrome (needs Chrome)
    make build        # frontend build + local binary

Frontend hot-reload loop: run the Go server with
`./docs -allow-origin http://localhost:5173`, then `cd web && npm run dev`
and use http://localhost:5173 (API and websockets proxy through vite).
End-to-end sync check (needs a running server): `cd web && node scripts/e2e.mjs`

## Deploy

    make release      # dist/docs-linux-arm64, static binary
    make deploy       # on the server: git pull && docker compose up -d --build

### Notification email (optional)

Off unless `-smtp` is set, and the app is whole without it: mentions and
replies always land in the in-app inbox. Mail covers the two events where the
recipient is by definition not in the app — you were mentioned, and a document
was shared with you.

Submission only, to a relay that already exists. This app never touches SPF,
DKIM, DMARC or bounces; if mail matters more than best-effort, the relay is
where to fix it.

The Dockerfile's ENTRYPOINT carries the base flags, so add these in
`docker-compose.yml` — `command:` is appended to it:

    command: ["-smtp", "relay.internal:587",
              "-mail-from", "docs@example.com",
              "-base-url", "https://docs.example.com"]
    environment:
      SMTP_USERNAME: docs
      SMTP_PASSWORD: ...

Credentials come from the environment rather than the command line, which is
visible in `ps`. `-base-url` is required with `-smtp` and refused at startup
without it: the server has no other way to know its own public URL, and a
message whose only link is broken is worse than no message.
