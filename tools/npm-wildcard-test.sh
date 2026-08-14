#!/bin/sh
# Does nginx proxy manager tolerate a whole `server` block in its custom
# http.conf, and does a wildcard server_name there actually match?
#
# This is the one unverified assumption under the demo design: the supervisor
# routes *.demo.<domain> on the Host header itself, so the proxy in front only
# has to pass the wildcard through. NPM's UI cannot express that (issue #749,
# closed 2020), leaving this file as the plan. See DESIGN-DECISIONS.md,
# *A subdomain per session*.
#
# Needs no DNS and no certificate. The question is whether nginx accepts the
# block and matches on it, and `curl -H Host:` sets the matching key directly.
# The domain below is a reserved .test name that resolves nowhere and cannot
# collide with a real proxy host.
#
# Safety: nothing is reloaded until `nginx -t` passes, an existing http.conf is
# preserved, and the file is put back the way it was found on every exit path
# including failure and Ctrl-C. Intended for a scratch VM rather than a proxy
# with anything real behind it — the safety machinery is what makes an
# inconclusive run harmless, not a licence to run it in production.
#
# Usage: ./npm-wildcard-test.sh [container] [live-host-to-regression-check]
#   e.g. ./npm-wildcard-test.sh nginx-proxy-manager files.example.com
#
# On a *fresh* NPM the second argument is the one worth arranging. Check (d)
# proves an exact server_name still beats the wildcard, and a clean install has
# no host for it to beat — so add one dummy proxy host in the UI first. Any
# name pointing anywhere; it does not have to work, only to exist.

set -eu

NPM=${1:-nginx-proxy-manager}
LIVE=${2:-}
DOMAIN=demo.owndocs.test
CONF=/data/nginx/custom/http.conf
BACKUP=/data/nginx/custom/http.conf.owndocs-bak

say() { printf '\n=== %s\n' "$1"; }
ex() { docker exec "$NPM" "$@"; }

# ---------------------------------------------------------------------------
# 0. Read-only checks. If the include is not there, nothing below can work and
#    we have the answer without touching anything.
# ---------------------------------------------------------------------------
say "container"
docker inspect -f '{{.Name}} up={{.State.Running}} image={{.Config.Image}}' "$NPM"

say "is /data/nginx/custom/http.conf actually included?"
if ex grep -rn 'custom/http.conf' /etc/nginx/nginx.conf /etc/nginx/conf.d 2>/dev/null; then
  echo "-> include found"
else
  echo "-> NOT FOUND. This NPM build does not include that file; stop here."
  echo "   Fallbacks: a custom nginx container, or exposing the demo directly."
  exit 1
fi

say "existing custom http.conf, if any"
ex sh -c "[ -f $CONF ] && cat $CONF || echo '(none)'"

# ---------------------------------------------------------------------------
# 1. Install the probe. Restore on ANY exit, including a failed nginx -t.
# ---------------------------------------------------------------------------
cleanup() {
  say "cleanup"
  ex sh -c "if [ -f $BACKUP ]; then mv $BACKUP $CONF; else rm -f $CONF; fi"
  # Validate the restored state too: leaving a broken config behind would be a
  # far worse outcome than an inconclusive test.
  if ex nginx -t 2>&1; then
    ex nginx -s reload && echo "-> restored and reloaded"
  else
    echo "!! RESTORED CONFIG DOES NOT VALIDATE — do not restart this container."
    echo "!! Inspect $CONF by hand before doing anything else."
  fi
}
trap cleanup EXIT INT TERM

say "installing probe"
ex sh -c "[ -f $CONF ] && cp $CONF $BACKUP || true"
ex sh -c "mkdir -p /data/nginx/custom && cat > $CONF <<'EOF'
# owndocs wildcard probe — temporary, removed by npm-wildcard-test.sh
server {
    listen 80;
    server_name *.$DOMAIN;
    location / { return 200 \"wildcard ok\n\"; }
}
EOF"
ex cat "$CONF"

# ---------------------------------------------------------------------------
# 2. The gate. Nothing is reloaded unless this passes.
# ---------------------------------------------------------------------------
say "nginx -t (the gate)"
if ! ex nginx -t 2>&1; then
  echo "-> config REJECTED. Nothing was reloaded; the running proxy is untouched."
  echo "-> Answer: NPM does not accept a server block here."
  exit 1
fi

say "reload"
ex nginx -s reload
echo "-> reloaded"

# ---------------------------------------------------------------------------
# 3. The three assertions.
# ---------------------------------------------------------------------------
probe() { ex curl -s -o - -w ' [http %{http_code}]\n' -H "Host: $1" http://127.0.0.1/ || true; }

say "a: one label under the wildcard  (expect: wildcard ok)"
probe "abc123.$DOMAIN"

say "b: two labels                    (expect: NOT wildcard ok)"
echo "   confirms a leading wildcard matches exactly one label, so a session"
echo "   token can never contain a dot"
probe "a.b.$DOMAIN"

say "c: the bare domain               (expect: NOT wildcard ok)"
probe "$DOMAIN"

if [ -n "$LIVE" ]; then
  say "d: existing host $LIVE           (expect: unchanged, NOT wildcard ok)"
  echo "   confirms an exact server_name still beats the wildcard, so adding"
  echo "   this block cannot capture traffic from a real proxy host"
  probe "$LIVE"
else
  say "d: SKIPPED — no host given"
  echo "   The wildcard-cannot-capture-a-real-host assertion did not run."
  echo "   Add a dummy proxy host in the NPM UI and pass its name as \$2."
fi

say "done — cleanup runs next"

# Still open after this passes: whether the file survives a container restart,
# not just a reload. NPM regenerates its proxy_host confs on boot and custom/
# is documented as user territory, but that is inference. Worth one deliberate
# `docker restart` with the probe installed — on this VM, where the brief
# outage costs nothing.
