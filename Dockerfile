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
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /docs .

FROM alpine:3.22
RUN adduser -D -H docs
USER docs
COPY --from=build /docs /usr/local/bin/docs
VOLUME /data
EXPOSE 8484
ENTRYPOINT ["docs", "-addr", ":8484", "-db", "/data/docs.db"]
