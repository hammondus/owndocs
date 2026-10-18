# The app image, built on the deploy host by `make deploy`. Three stages:
# the frontend bundle, the Go binary that embeds it, and a distroless runtime
# holding nothing but that binary. See DESIGN-DECISIONS.md, *The app image
# follows the house Docker standard*.

# npm ci, not install: it refuses to run when the lock file and package.json
# disagree, so the image gets exactly the dependencies the repo pins.
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

# A minor tag, never a patch pin: Go's security fixes ship in patch releases
# and are compiled into the binary, and `--pull` picks them up. No GOARCH:
# the build runs natively on the deploy host. The cache mounts keep the
# module and build caches on the host, so a deploy recompiles what changed
# rather than every dependency.
FROM golang:1.27 AS build
WORKDIR /src
COPY . .
COPY --from=web /src/web/static ./web/static
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/owndocs .
# Created here with the runtime user as owner, because distroless has no
# shell to do it in. A named volume mounted at /data inherits this ownership;
# a bind mount does not, so the README says to chown the host directory.
RUN mkdir -m 0700 /out/data

# The Debian release is in the tag so a move to the next major is a commit.
# No shell in the image: for one, attach busybox with --pid and --network
# set to this container.
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/owndocs /owndocs
COPY --from=build --chown=nonroot:nonroot /out/data /data
EXPOSE 8484
# The binary probes itself; distroless has no curl. Docker does not restart
# an unhealthy container, so this shows status and nothing more.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/owndocs", "-addr", ":8484", "-healthcheck"]
# The base flags live in ENTRYPOINT rather than CMD so a compose `command:`
# adds to them (the mail flags, for one) instead of replacing them. The
# database filename stays docs.db: it names a file inside a volume, nobody
# sees it, and changing it would orphan an existing volume for no gain.
ENTRYPOINT ["/owndocs", "-addr", ":8484", "-db", "/data/docs.db", "-signup=closed"]
