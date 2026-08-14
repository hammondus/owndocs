# Own Docs

Self-hosted collaborative documents + spreadsheets — your own docs, on your own
machine. Go backend, Svelte 5
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
`./owndocs -allow-origin http://localhost:5173`, then `cd web && npm run dev`
and use http://localhost:5173 (API and websockets proxy through vite).
End-to-end sync check (needs a running server): `cd web && node scripts/e2e.mjs`

## Deploy

    make release      # dist/owndocs-linux-arm64, static binary
    make deploy       # on the server: git pull && docker compose up -d --build

### Backups

    make backup       # on the server: a verified, timestamped copy in ./data/backups
    make backup-local # the same against a local dev database

Safe to run while people are editing — it is a read transaction, and WAL
readers do not block writers. Every backup is reopened and checked before it
is reported as good, so a run that prints `backup ok:` has been proved to open,
pass an integrity check, and contain users, documents and their update log.

**Do not back this up by copying `docs.db`.** SQLite runs in WAL mode here, so
committed writes sit in `docs.db-wal` until a checkpoint: a plain copy is a
valid, openable database silently missing everything since the last one.
Measured, and the numbers are in `DESIGN-DECISIONS.md` under *Backups*.

Scheduling it is yours to own, and so is the second copy — the target above is
inside the data volume, on the same disk as the database, which helps with a
mistake and not with a dead disk:

    0 3 * * *  cd /srv/owndocs && make backup && rsync -a data/backups/ elsewhere:/owndocs/

To restore: stop the server, put the backup file at the database path, start it.

    docker compose down
    cp data/backups/docs-20260814T220345Z.db data/docs.db
    docker compose up -d

Backups contain password hashes and live session tokens. They are written
`0600`; keep them that way wherever they are copied to.

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
              "-mail-from", "owndocs@example.com",
              "-base-url", "https://docs.example.com"]
    environment:
      SMTP_USERNAME: owndocs
      SMTP_PASSWORD: ...

Credentials come from the environment rather than the command line, which is
visible in `ps`. `-base-url` is required with `-smtp` and refused at startup
without it: the server has no other way to know its own public URL, and a
message whose only link is broken is worse than no message.
