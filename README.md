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

Documents can be filed into folders, and a folder carries access: share the
folder once and everyone on it reaches every document inside, at the role the
folder grants. The document list has two views — **recent**, the flat list
newest first, and **folders**, the tree. Moving a document into a folder gives
that folder's people access to it, so the move control says so, and when
notification email is on they are told, the way a direct share tells them. An
open document shows the folders above it in its bar, and search finds folders
by name; either lands on the folder in the list.

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
    make deploy       # on the server: git pull, docker compose build --pull, up -d

The container runs as an unprivileged user (uid 65532) and keeps its database
in `./data`, a bind mount, so before the first start on a server give it that
directory:

    mkdir -p data && sudo chown -R 65532:65532 data

The compose file also starts the website: the pages in `site/`, served by
nitro on port 8485 as they are in the repo, so a deploy updates both. Every
claim on the site that carries a `data-` attribute is checked against the code
by `make test`; see `DESIGN-DECISIONS.md`, *The enforced tier is data
attributes, not prose*.

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

### Export to git (optional)

Mirrors **named versions** into a git repository, one commit per pin:

    cd web
    DOCS_EMAIL=you@example.com DOCS_PASSWORD=... \
      node scripts/exporter.mjs https://docs.example.com /path/to/repo --once

It creates the repo if the directory is empty, and `--once` does a single pass
(cron friendly). Without it, the exporter polls — `--interval=60` sets the
seconds. Rerunning when nothing new has been pinned does nothing at all, so a
schedule is safe.

It is just another client: it logs in with an ordinary account and only sees
documents that account has access to. The account needs a real password, so a
dev quick-login user will not do. Credentials come from the environment rather
than argv, which is visible in `ps`.

**Grant the account at each root folder it should mirror, and leave it
there.** The repo mirrors the folder tree as that account sees it, and a
folder it holds no grant on is not named to it: a document inside one lands at
the top level, and granting the account a folder higher up moves every path
beneath it on the next run. The exporter prints how many documents sit at the
top level when that number changes, which is the line to read when the repo
does not match the app.

What lands in the repo:

- A document becomes `slug(title)-<6 chars of id>.md` inside one directory per
  folder above it, each named the same way; a sheet becomes a directory of one
  CSV per tab. A retitle or a move is a commit of its own, which git shows as
  a rename.
- One commit per pinned version, oldest first, authored by whoever pinned it
  and dated when they pinned it. Each carries `Docs-Doc:` and `Docs-Version:`
  trailers tying it back.
- `.docs-export.json` records what has been exported and is committed with it,
  so a clone of the repo can continue exporting.

**Sessions are not exported, deliberately** — pinning a version *is* the act of
saying "this one is a commit", and exporting every session would bury the
meaningful states. To see what changed between two points that were never
pinned, use the **Changes** view in the app's history instead.

The exporter never adds a remote. Pushing somewhere is yours to arrange.

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
