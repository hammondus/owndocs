BIN := docs

.PHONY: build js test run release clean docker-build deploy logs

# The Go binary embeds web/static, so the JS bundle must exist before go build.
build: js
	go build -o $(BIN) .

# Clear previous build output by hand (rather than vite's emptyOutDir) so
# static/.gitkeep survives — it keeps the go:embed path valid on fresh clones.
js:
	cd web && npm install --no-fund --no-audit && rm -rf static/assets static/index.html && npm run build

test:
	go vet ./... && go test ./...

# Local dev run: quick-login users + vite dev server origin allowed.
# Production runs via docker compose, whose entrypoint has neither flag.
run: build
	./$(BIN) -dev -allow-origin http://localhost:5173

# Backend deploy target is linux/arm64. CGO_ENABLED=0 is explicit even though
# every dep is pure Go — it guarantees the static binary if a dep ever changes.
# -s -w strips symbol tables and DWARF to shrink the artifact.
release: js
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o dist/$(BIN)-linux-arm64 .

clean:
	rm -f $(BIN)
	rm -rf dist web/static/assets web/static/index.html

docker-build:
	docker compose build

# Run on the server.
deploy:
	git pull && docker compose up -d --build

logs:
	docker compose logs -f docs
