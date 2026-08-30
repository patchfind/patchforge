#!/usr/bin/env bash
#
# Run the TrueForge control plane (API + admin UI) locally.
#
#   ./scripts/trueforge-local.sh up      # build if needed, then start
#   ./scripts/trueforge-local.sh status  # is it up, and is the sandbox live?
#   ./scripts/trueforge-local.sh logs
#   ./scripts/trueforge-local.sh down
#
# Serves the API and the UI together on 8790. Bound to 0.0.0.0 so a browser on
# the Windows side of WSL2 can reach it; `npx` defaults to localhost-only, which
# is the usual reason the UI "will not open".
set -uo pipefail

IMAGE=trueforge:local
NAME=trueforge
PORT="${TRUEFORGE_PORT:-8790}"
VERSION="${TRUEFORGE_VERSION:-0.1.4}"
BUILD_DIR="${TMPDIR:-/tmp}/trueforge-image"
# TrueForge calls the model provider over HTTPS. On a network that terminates
# TLS at an inspecting proxy the image's own CA set is not enough, so the host
# trust store is mounted in. Harmless elsewhere.
HOST_CA_BUNDLE="${HOST_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else B=""; G=""; Y=""; R=""; N=""; fi

build_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 && return 0
  echo "${B}Building $IMAGE${N} (first run only)"
  mkdir -p "$BUILD_DIR"
  cat > "$BUILD_DIR/Dockerfile" <<EOF
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production STANDALONE=true HOST=0.0.0.0 PORT=8790
# bubblewrap/socat/ripgrep are the local sandbox's host deps; python3 runs in it.
# ca-certificates so outbound HTTPS verifies.
RUN apt-get update && apt-get install -y --no-install-recommends \\
      bubblewrap socat ripgrep python3 ca-certificates \\
  && rm -rf /var/lib/apt/lists/*
RUN npm install --omit=dev @truefoundry/trueforge@${VERSION} && npm cache clean --force
EXPOSE 8790
CMD ["node", "node_modules/@truefoundry/trueforge/dist/main.js"]
EOF
  docker build -t "$IMAGE" "$BUILD_DIR" 2>&1 | tail -3
}

case "${1:-up}" in
  up)
    build_image
    docker rm -f "$NAME" >/dev/null 2>&1
    # seccomp=unconfined: bubblewrap needs unprivileged user namespaces, which
    # Docker's default profile blocks. Without it the sandbox silently dies and
    # skills never mount.
    # shellcheck disable=SC2086
    docker run -d --name "$NAME" \
      --security-opt seccomp=unconfined \
      --add-host host.docker.internal:host-gateway \
      -p "${PORT}:8790" \
      ${DAYTONA_API_URL:+-e DAYTONA_API_URL=$DAYTONA_API_URL} \
      -v trueforge-data:/root/.local/share/trueforge \
      -v "${HOST_CA_BUNDLE}:${HOST_CA_BUNDLE}:ro" \
      -e NODE_EXTRA_CA_CERTS="${HOST_CA_BUNDLE}" \
      "$IMAGE" >/dev/null
    printf 'Waiting for TrueForge'
    for _ in $(seq 1 40); do
      curl -sf -m 2 "http://localhost:${PORT}/api/v1/capabilities" >/dev/null 2>&1 && break
      printf '.'; sleep 3
    done
    echo
    caps=$(curl -s -m 5 "http://localhost:${PORT}/api/v1/capabilities" 2>/dev/null)
    if [ -z "$caps" ]; then
      echo "${R}Did not come up.${N}"; docker logs "$NAME" --tail 20; exit 1
    fi
    echo "${G}TrueForge is up.${N}"
    echo
    echo "  ${B}UI + API${N}  http://localhost:${PORT}"
    wslip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$wslip" ] && echo "  ${B}From Windows${N} (if localhost fails)  http://${wslip}:${PORT}"
    echo
    case "$caps" in
      *'"sandbox":{"enabled":true}'*) echo "  ${G}sandbox: enabled${N}  skills will mount" ;;
      *) echo "  ${Y}sandbox: DISABLED${N} — skills will not mount, so they cannot be used."
         reason=$(docker logs "$NAME" 2>&1 | grep -i "local sandbox" | tail -1)
         echo "  ${D}${reason}${N}"
         case "$reason" in
           *"host dependencies missing"*)
             echo "  ${Y}Fix:${N} the image is missing bwrap/socat/rg — rebuild it:"
             echo "       docker rmi $IMAGE && $0 up" ;;
           *"namespace"*|*"permission"*)
             echo "  ${Y}Fix:${N} the kernel is blocking unprivileged user namespaces."
             echo "       sudo sysctl -w kernel.unprivileged_userns_clone=1"
             echo "       (some distros also need: sudo sysctl -w user.max_user_namespaces=15000)" ;;
           *) echo "  ${Y}Fix:${N} see intro.md section 3." ;;
         esac ;;
    esac
    echo
    echo "  Configure under Settings: Models, Connectors, Skills, Sandbox providers."
    echo "  Details and exact values: intro.md section 5."
    ;;
  status)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "${Y}not running${N} — start it with: $0 up"; exit 1
    fi
    docker ps --filter "name=^${NAME}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo; echo -n "  capabilities: "; curl -s -m 5 "http://localhost:${PORT}/api/v1/capabilities"; echo
    ;;
  logs) docker logs -f "$NAME" ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped (data kept in the trueforge-data volume)" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
