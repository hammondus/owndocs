# The website's server: a pinned nitro release on distroless, and nothing
# else. docker-compose.yml bind-mounts the pages and site.conf, so the
# image never has to change for a content or config edit.
FROM golang:1.27 AS build

# The nitro release the site runs. To move to a newer nitro, bump this tag.
ARG NITRO_VERSION=v0.0.4
# go install pkg@version resolves through the module proxy, outside any
# main module, so the build needs no checkout. CGO_ENABLED=0 keeps the
# binary static for the distroless base.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go install -trimpath -ldflags='-s -w' \
      github.com/hammondus/nitro@${NITRO_VERSION}

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /go/bin/nitro /nitro
EXPOSE 8080
# The binary probes itself: distroless has no shell and no curl.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/nitro", "-c", "/etc/nitro/nitro.conf", "-healthcheck"]
ENTRYPOINT ["/nitro"]
CMD ["-c", "/etc/nitro/nitro.conf"]
