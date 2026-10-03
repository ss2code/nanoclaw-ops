#!/bin/bash
# Build the NanoClaw agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

FINGERPRINT_FILES=(
    Dockerfile cli-tools.json install-cli-tools.sh entrypoint.sh build.sh
    agent-runner/package.json agent-runner/bun.lock
)
fingerprint_lines="INSTALL_CJK_FONTS=${INSTALL_CJK_FONTS:-false}
"
for file in "${FINGERPRINT_FILES[@]}"; do
    if command -v shasum >/dev/null 2>&1; then
        digest="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        digest="$(sha256sum "$file" | awk '{print $1}')"
    fi
    fingerprint_lines+="${file}:${digest}
"
done
if command -v shasum >/dev/null 2>&1; then
    BUILD_FINGERPRINT="$(printf '%b' "$fingerprint_lines" | shasum -a 256 | awk '{print $1}')"
else
    BUILD_FINGERPRINT="$(printf '%b' "$fingerprint_lines" | sha256sum | awk '{print $1}')"
fi
BUILD_ARGS+=(--build-arg "NANOCLAW_BUILD_FINGERPRINT=${BUILD_FINGERPRINT}")

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build --pull "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
