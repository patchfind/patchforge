#!/usr/bin/env bash
#
# Run Daytona locally and point TrueForge at it.
#
#   ./scripts/daytona-local.sh up       # clone (once) and start
#   ./scripts/daytona-local.sh status   # service + API health
#   ./scripts/daytona-local.sh down     # stop, keep data
#   ./scripts/daytona-local.sh destroy  # stop and delete volumes
#
# Daytona's OSS repo was discontinued in June 2026; v0.190.0 is the last
# self-hostable tag. Verified working against TrueForge 0.1.4 — TrueForge's
# bundled SDK (0.204.1) talks to this server's snapshot API without complaint.
set -uo pipefail

REPO_URL=https://github.com/daytonaio/daytona.git
TAG=v0.190.0
CHECKOUT="${DAYTONA_CHECKOUT:-$HOME/.cache/daytona-oss}"
# Only what the API needs. Dropped: pgadmin, registry-ui, maildev, jaeger,
# otel-collector, ssh-gateway — ~5 containers of RAM this box does not have.
SERVICES="db redis dex registry minio runner api proxy"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else B=""; G=""; Y=""; R=""; N=""; fi

compose() {
  docker compose -f "$CHECKOUT/docker/docker-compose.yaml" \
                 -f "$CHECKOUT/docker/local-override.yaml" "$@"
}

ensure_checkout() {
  if [ ! -d "$CHECKOUT/.git" ]; then
    echo "${B}Cloning Daytona $TAG${N} -> $CHECKOUT"
    git clone --branch "$TAG" --depth 1 "$REPO_URL" "$CHECKOUT" 2>&1 | tail -1
  fi
  # Trim the stack and silence OTEL, which otherwise dials a collector we skip.
  cat > "$CHECKOUT/docker/local-override.yaml" <<'EOF'
services:
  api:
    environment:
      - OTEL_ENABLED=false
    depends_on:
      db: {condition: service_started}
      redis: {condition: service_started}
      dex: {condition: service_started}
      registry: {condition: service_started}
      runner: {condition: service_started}
  runner:
    environment:
      - OTEL_ENABLED=false
EOF
}

case "${1:-up}" in
  up)
    ensure_checkout
    echo "${B}Starting${N} $SERVICES"
    # shellcheck disable=SC2086
    compose up -d $SERVICES 2>&1 | tail -3
    printf 'Waiting for the API'
    for _ in $(seq 1 60); do
      curl -sf -m 2 http://localhost:3000/api >/dev/null 2>&1 && break
      printf '.'; sleep 3
    done
    echo
    if curl -sf -m 3 http://localhost:3000/api >/dev/null 2>&1; then
      echo "${G}Daytona is up.${N}"
      cat <<EOF

${B}Next — one manual step (no API for this; login is OIDC-only)${N}

  1. Open   http://localhost:3000
     Log in dev@daytona.io / password
  2. Confirm the default snapshot is Active:
       http://localhost:3000/dashboard/snapshots
     TrueForge clones every sandbox from a snapshot, so this must be ready.
  3. Create an API key with ${B}Sandboxes${N} + ${B}Snapshots (create/delete)${N}.
  4. Point TrueForge at it and register the provider:

     DAYTONA_API_URL=http://host.docker.internal:3000/api   # on the TRUEFORGE process
     curl -X PUT http://localhost:8790/api/v1/settings/sandbox-providers \\
       -H 'Content-Type: application/json' -d '{"manifest":{
       "type":"daytona","auth":{"api_key":"<KEY>"},"exec_timeout_ms":600000,
       "auto_stop_interval_in_minutes":15,"auto_archive_interval_in_minutes":60,
       "auto_delete_interval_in_minutes":1440}}'

  It then shows under ${B}Settings -> Sandbox providers${N} in the TrueForge UI.

${Y}Note:${N} Daytona holds host port 3000. Set HARNESS_HOST_PORT=3100 and
HARNESS_WS_HOST_PORT=3101 in .env so PatchForge does not collide.
EOF
    else
      echo "${R}API did not come up.${N} Logs:"
      compose logs api --tail 20 2>&1 | tail -20
      exit 1
    fi
    ;;
  status)
    [ -d "$CHECKOUT/.git" ] || { echo "not cloned; run: $0 up"; exit 1; }
    compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null
    printf '\nAPI  '; curl -s -m 5 -o /dev/null -w 'GET /api -> %{http_code}\n' http://localhost:3000/api
    ;;
  down)    ensure_checkout; compose stop $SERVICES 2>&1 | tail -3 ;;
  destroy) ensure_checkout; compose down -v --remove-orphans 2>&1 | tail -3 ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
