#!/usr/bin/env bash
#
# Bring up the whole PatchForge system, in dependency order.
#
#   ./scripts/start.sh                  # TrueForge + PatchForge
#   ./scripts/start.sh --with-daytona   # ...and a local Daytona sandbox provider
#   ./scripts/start.sh --no-trueforge   # PatchForge only (control plane elsewhere)
#   ./scripts/start.sh status           # what is up, and what is still unconfigured
#   ./scripts/start.sh stop             # stop everything this script started
#
# Ends by reporting which Plane 1 assets are still missing, because those are
# configured by hand and are the usual reason a run fails later.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_DAYTONA=false
WITH_TRUEFORGE=true
CMD=up

for arg in "$@"; do
  case "$arg" in
    --with-daytona) WITH_DAYTONA=true ;;
    --no-trueforge) WITH_TRUEFORGE=false ;;
    status|stop|up)  CMD="$arg" ;;
    --help|-h) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else B=""; D=""; G=""; Y=""; R=""; N=""; fi

TF_PORT="${TRUEFORGE_PORT:-8790}"
TF_URL="http://localhost:${TF_PORT}"

step() { printf '\n%s==>%s %s\n' "$B" "$N" "$1"; }
ok()   { printf '  %s+%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
bad()  { printf '  %sx%s %s\n' "$R" "$N" "$1"; }

# Wait for a URL to answer, up to N seconds.
wait_http() {
  local url=$1 secs=${2:-90} i=0
  while [ $i -lt "$secs" ]; do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 3; i=$((i+3))
  done
  return 1
}

# --------------------------------------------------------------------- stop --
if [ "$CMD" = stop ]; then
  step "Stopping PatchForge"
  docker compose stop 2>&1 | tail -2
  step "Stopping TrueForge"
  ./scripts/trueforge-local.sh down 2>/dev/null || true
  if [ -d "${DAYTONA_CHECKOUT:-$HOME/.cache/daytona-oss}/.git" ]; then
    step "Stopping Daytona"
    ./scripts/daytona-local.sh down 2>/dev/null | tail -2 || true
  fi
  echo; ok "stopped"
  exit 0
fi

# ------------------------------------------------------------------- status --
report_plane1() {
  step "Plane 1 (configure at ${TF_URL})"
  if ! curl -sf -m 3 "${TF_URL}/api/v1/capabilities" >/dev/null 2>&1; then
    bad "TrueForge is not reachable — nothing to report"
    return
  fi
  local models mcp skills
  models=$(curl -s -m 5 "${TF_URL}/api/v1/models" 2>/dev/null)
  mcp=$(curl -s -m 5 "${TF_URL}/api/v1/settings/mcp-servers" 2>/dev/null)
  skills=$(curl -s -m 5 "${TF_URL}/api/v1/skills" 2>/dev/null)

  case "$models" in
    *'"name"'*) ok    "model:  $(echo "$models" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)" ;;
    *)          warn  "model:  none — Settings > Models (intro.md 5a)" ;;
  esac
  case "$mcp" in
    *'"name"'*) ok    "mcp:    $(echo "$mcp" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)" ;;
    *)          warn  "mcp:    none — Settings > Connectors (intro.md 5b)" ;;
  esac
  local n; n=$(echo "$skills" | grep -o '"name"' | wc -l)
  if [ "$n" -gt 0 ]; then ok "skills: $n registered"
  else warn "skills: none — Settings > Skills (intro.md 5c)"; fi

  # The gateway asks GitHub whether the token really works. A present-but-dead
  # token used to surface only as a 502 in the middle of a scan.
  # Ask GitHub directly; there is no gateway to ask any more.
  local tok ghcode
  tok=$(grep -E '^GITHUB_TOKEN=.' .env 2>/dev/null | cut -d= -f2-)
  if [ -z "$tok" ]; then
    warn "github: GITHUB_TOKEN empty in .env — private repos and PRs will fail"
  else
    ghcode=$(curl -s -m 10 -o /dev/null -w '%{http_code}' \
             -H "Authorization: Bearer $tok" -H 'User-Agent: patchforge' \
             https://api.github.com/rate_limit 2>/dev/null)
    case "$ghcode" in
      200) ok   "github: token valid" ;;
      401) warn "github: token INVALID (401) — check GITHUB_TOKEN in .env" ;;
      "")  warn "github: could not reach api.github.com" ;;
      *)   warn "github: unexpected $ghcode from api.github.com" ;;
    esac
  fi

  # Sandbox: either a Daytona row, or the built-in local one.
  local caps; caps=$(curl -s -m 5 "${TF_URL}/api/v1/capabilities" 2>/dev/null)
  if curl -sf -m 3 "${TF_URL}/api/v1/settings/sandbox-providers" >/dev/null 2>&1; then
    ok "sandbox: Daytona provider registered"
  elif [ "${caps#*'"sandbox":{"enabled":true}'}" != "$caps" ]; then
    ok "sandbox: built-in local sandbox (no provider row needed)"
  else
    bad "sandbox: DISABLED — skills will not mount (intro.md 3)"
  fi
}

print_urls() {
  step "URLs"
  echo "  ${B}TrueForge${N}   ${TF_URL}          control plane: UI + API"
  echo "  ${B}PatchForge${N}  http://localhost:3002         showcase UI"
  echo "  ${D}pool-monitor  http://localhost:8080${N}"
  echo "  ${D}advisory      http://localhost:8081${N}"
  $WITH_DAYTONA && echo "  ${B}Daytona${N}     http://localhost:3000         dev@daytona.io / password"
  local wslip; wslip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$wslip" ] && printf '\n  %sIf localhost fails from a Windows browser: http://%s:%s%s\n' "$D" "$wslip" "$TF_PORT" "$N"
}

if [ "$CMD" = status ]; then
  step "Containers"
  docker ps --format '{{.Names}}\t{{.Status}}' \
    | grep -E 'trueforge|patchforge|daytona' | sed 's/^/  /' || echo "  none"
  report_plane1
  print_urls
  exit 0
fi

# ----------------------------------------------------------------------- up --
[ -f .env ] || { cp .env.example .env; warn "created .env from the example"; }

# Daytona owns host port 3000, so the harness has to move out of its way.
if $WITH_DAYTONA; then
  export HARNESS_HOST_PORT="${HARNESS_HOST_PORT:-3100}"
  export HARNESS_WS_HOST_PORT="${HARNESS_WS_HOST_PORT:-3101}"
fi

# A bind-mount whose source does not exist makes Docker create an empty
# DIRECTORY at that path inside the container. Mounted over the CA bundle that
# silently destroys TLS for every outbound call, so check before mounting.
CA="${HOST_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
if [ ! -f "$CA" ]; then
  warn "CA bundle not found at $CA — mounting the image's own instead"
  # Point both ends at a file that definitely exists so the mount is a no-op.
  export HOST_CA_BUNDLE=/etc/hosts
  export CA_BUNDLE_IN_CONTAINER=/etc/hosts
fi

if grep -qE '^GITHUB_TOKEN=$' .env 2>/dev/null; then
  warn "GITHUB_TOKEN is empty in .env — no repo reads, no pull requests"
fi

if $WITH_DAYTONA; then
  step "Daytona (local sandbox provider)"
  ./scripts/daytona-local.sh up 2>&1 | grep -E 'Cloning|Starting|is up|did not' | sed 's/^/  /'
  if wait_http http://localhost:3000/api 120; then
    ok "Daytona API on :3000"
    # TrueForge finds Daytona through this, not through its provider config.
    export DAYTONA_API_URL="${DAYTONA_API_URL:-http://host.docker.internal:3000/api}"
  else
    bad "Daytona did not come up; continuing without it"
  fi
fi

if $WITH_TRUEFORGE; then
  step "TrueForge (control plane)"
  # Keep the reason lines: "sandbox: DISABLED" alone says nothing actionable,
  # and the following line is what names the missing dependency or permission.
  TRUEFORGE_PORT="$TF_PORT" ./scripts/trueforge-local.sh up 2>&1 \
    | grep -vE '^\s*$|^  Configure under|^  Details and|^  UI \+ API|^  From Windows' \
    | sed 's/^/  /'
  wait_http "${TF_URL}/api/v1/capabilities" 120 && ok "TrueForge on :${TF_PORT}" \
    || bad "TrueForge did not come up"
else
  step "TrueForge"; echo "  ${D}skipped (--no-trueforge)${N}"
fi

step "PatchForge services"
# Capture in full: a build failure here is the reason a service never appears,
# and grepping the output hides exactly the lines that explain it.
compose_log=$(mktemp)
if ! docker compose up -d --build >"$compose_log" 2>&1; then
  bad "docker compose failed — the real error follows"
  tail -25 "$compose_log" | sed 's/^/    /'
  echo
  warn "full log: $compose_log"
else
  grep -iE 'error|warning' "$compose_log" | head -5 | sed 's/^/  /'
  rm -f "$compose_log"
fi

# A service can also exit right after starting, which `up -d` reports as success.
sleep 2
for svc in advisory-service pool-monitor checkpoint-gateway trueforge-harness; do
  state=$(docker compose ps -a --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')
  case "$state" in
    running|"") ;;
    *) bad "$svc is $state — logs:"
       docker compose logs "$svc" --tail 15 2>/dev/null | sed 's/^/    /' ;;
  esac
done
for svc_port in "advisory-service:8081" "pool-monitor:8080" "checkpoint-gateway:3002"; do
  svc=${svc_port%%:*}; port=${svc_port##*:}
  probe="http://localhost:${port}/healthz"
  [ "$svc" = checkpoint-gateway ] && probe="http://localhost:${port}/"
  if wait_http "$probe" 120; then ok "$svc on :$port"
  else bad "$svc did not become healthy on :$port"; fi
done

report_plane1
print_urls

step "Next"
echo "  1. Configure anything marked ${Y}!${N} above (intro.md section 5)."
echo "  2. Check it:  ./scripts/start.sh status"
echo "  3. Add a repo in the showcase UI and watch the trace."
