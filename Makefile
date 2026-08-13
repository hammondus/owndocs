BIN := docs

.PHONY: build js runner-js runner test run release clean docker-build deploy logs

# The Go binary embeds web/static, so the JS bundle must exist before go build.
build: js runner-js
	go build -o $(BIN) .

# Clear previous build output by hand (rather than vite's emptyOutDir) so
# static/.gitkeep survives — it keeps the go:embed path valid on fresh clones.
js: web/node_modules
	cd web && rm -rf static/assets static/index.html && npm run build

# Installed once, as a real target rather than every build.
web/node_modules:
	cd web && npm install --no-fund --no-audit

# The headless runner embeds the SAME model the browser runs, bundled for
# Sobek. go:embed needs it present before any build or vet of ./cmd/runner.
runner-js: web/node_modules
	cd web && npx esbuild src/runner.js --bundle --format=iife --target=es2020 \
		--outfile=../cmd/runner/runtime.js --log-level=warning

runner: runner-js
	go build -o runner ./cmd/runner

test: runner-js
	go vet ./... && go test ./...
	# The headless JS suites. They existed but nothing ran them, so a break in
	# the model, the formula engine, the anchors or the reading prefs was only
	# ever found by hand. None of them needs a server.
	cd web && node scripts/sheet_test.mjs && node scripts/exact_test.mjs && node scripts/table_test.mjs && node scripts/mdtext_test.mjs && node scripts/mdext_test.mjs && node scripts/diff_test.mjs && node scripts/prefs_test.mjs

# Browser-level checks: the only tests that mount a component, and the only
# ones that can see a thrown error inside an {#if} presenting as a dead
# control (three incidents and counting). Separate from `test` because it
# needs the built binary and a real Chrome — CHROME_PATH overrides the
# lookup. Kept out of `test` for the same reason e2e.mjs is: extra moving
# parts that a plain unit run should not depend on.
.PHONY: test-ui
test-ui: build
	cd web && node scripts/ui_test.mjs

# Local dev run: quick-login users + vite dev server origin allowed.
# Production runs via docker compose, whose entrypoint has neither flag.
run: build
	./$(BIN) -dev -allow-origin http://localhost:5173

# Backend deploy target is linux/arm64. CGO_ENABLED=0 is explicit even though
# every dep is pure Go — it guarantees the static binary if a dep ever changes.
# -s -w strips symbol tables and DWARF to shrink the artifact.
release: js runner-js
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o dist/$(BIN)-linux-arm64 .
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o dist/runner-linux-arm64 ./cmd/runner

clean:
	rm -f $(BIN) runner cmd/runner/runtime.js
	rm -rf dist web/static/assets web/static/index.html

docker-build:
	docker compose build

# Run on the server.
deploy:
	git pull && docker compose up -d --build

logs:
	docker compose logs -f docs
