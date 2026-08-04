BIN := docs

.PHONY: build js test run release clean docker-build deploy logs

# The Go binary embeds web/static, so the JS bundle must exist before go build.
build: js
	go build -o $(BIN) .

js:
	cd web && npm install --no-fund --no-audit && npm run build

test:
	go vet ./... && go test ./...

run: build
	./$(BIN)

# Backend deploy target is linux/arm64. CGO_ENABLED=0 is explicit even though
# every dep is pure Go — it guarantees the static binary if a dep ever changes.
# -s -w strips symbol tables and DWARF to shrink the artifact.
release: js
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o dist/$(BIN)-linux-arm64 .

clean:
	rm -f $(BIN)
	rm -rf dist web/static/demo.js

docker-build:
	docker compose build

# Run on the server.
deploy:
	git pull && docker compose up -d --build

logs:
	docker compose logs -f docs
