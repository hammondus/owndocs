FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm install --no-fund --no-audit
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/static ./web/static
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /owndocs .

FROM alpine:3.22
RUN adduser -D -H owndocs
USER owndocs
COPY --from=build /owndocs /usr/local/bin/owndocs
VOLUME /data
EXPOSE 8484
# The database filename stays docs.db: it names a file inside a volume, nobody
# sees it, and changing it would orphan an existing volume for no gain.
ENTRYPOINT ["owndocs", "-addr", ":8484", "-db", "/data/docs.db", "-signup=closed"]
