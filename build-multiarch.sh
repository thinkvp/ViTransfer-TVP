#!/bin/bash

# ViTransfer Multi-Architecture Build Script
# Builds and pushes BOTH images (app + worker) for amd64 and arm64 platforms
# Usage: ./build-multiarch.sh [version|--dev|-dev<version>|latest] [--no-cache]
# Examples:
#   ./build-multiarch.sh 0.1.0         # Tag both images as 0.1.0 and latest
#   ./build-multiarch.sh --dev         # Tag as dev only
#   ./build-multiarch.sh -dev0.6.0     # Tag as dev-0.6.0 only (no latest)
#   ./build-multiarch.sh --dev --no-cache    # Tag as dev with no cache
#   ./build-multiarch.sh               # Tag from VERSION file (+ latest)
#   ./build-multiarch.sh latest        # Tag as latest

set -e

DOCKERHUB_USERNAME="${DOCKERHUB_USERNAME:-simbamcsimba}"
APP_IMAGE_NAME="vitransfer-app"
WORKER_IMAGE_NAME="vitransfer-worker"

# Default to VERSION file if present, otherwise 'latest'
DEFAULT_VERSION="latest"
if [ -f VERSION ]; then
    DEFAULT_VERSION="$(cat VERSION | tr -d ' \n\r\t')"
fi

VERSION="${1:-$DEFAULT_VERSION}"
NO_CACHE_FLAG=""

# Check for --no-cache flag
if [ "$2" = "--no-cache" ] || [ "$1" = "--no-cache" ]; then
    NO_CACHE_FLAG="--no-cache"
    echo "🔨 Building with --no-cache flag"
fi

# Check if we're building dev version with -dev prefix
if [[ "$VERSION" == -dev* ]]; then
    # Dev version format (-dev0.6.0) - tag as dev-<version> only, no latest
    VERSION="${VERSION:1}"  # Remove leading -
    APP_TAGS="${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:${VERSION}"
    WORKER_TAGS="${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:${VERSION}"
# Check if we're building dev
elif [ "$VERSION" = "--dev" ] || [ "$VERSION" = "dev" ]; then
    APP_TAGS="${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:dev"
    WORKER_TAGS="${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:dev"
    VERSION="dev"
# If version is provided, tag as both version and latest
elif [ "$VERSION" != "latest" ]; then
    APP_TAGS="${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:${VERSION} ${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:latest"
    WORKER_TAGS="${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:${VERSION} ${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:latest"
else
    APP_TAGS="${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:latest"
    WORKER_TAGS="${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:latest"
fi

echo "🏗️  ViTransfer Multi-Architecture Build"
echo "========================================"
echo ""

# Check if logged in to Docker Hub
echo "🔑 Checking Docker Hub login..."
if ! docker info | grep -q "Username: ${DOCKERHUB_USERNAME}"; then
    echo "⚠️  Not logged in to Docker Hub"
    echo "Please login:"
    docker login
else
    echo "✅ Logged in to Docker Hub as ${DOCKERHUB_USERNAME}"
fi

echo ""

# Check if buildx is available
echo "🔧 Checking Docker buildx..."
if ! docker buildx version &> /dev/null; then
    echo "❌ Error: Docker buildx is not available"
    echo "   Install with: docker buildx install"
    exit 1
fi
echo "✅ Docker buildx available"

echo ""

# Create or use existing buildx builder
echo "🛠️  Setting up multi-arch builder..."
if ! docker buildx ls | grep -q "multiarch-builder"; then
    echo "Creating new builder: multiarch-builder"
    docker buildx create --name multiarch-builder --driver docker-container --use
else
    echo "Using existing builder: multiarch-builder"
    docker buildx use multiarch-builder
fi

# Inspect builder
docker buildx inspect --bootstrap

echo ""
echo "🏗️  Building multi-architecture image..."
echo "   Version: ${VERSION}"
echo "   Platforms: linux/amd64, linux/arm64"
if [[ "$VERSION" == dev* ]]; then
    echo "   Tags: ${VERSION} (testing only, will NOT update latest)"
elif [ "$VERSION" != "latest" ]; then
    echo "   Tags: ${VERSION}, latest"
else
    echo "   Tags: latest"
fi
echo ""

echo "   App image:    ${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}"
echo "   Worker image: ${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}"
echo ""

build_and_push() {
    local target="$1"
    local tags="$2"
    local tag_args=""

    for tag in $tags; do
        tag_args="$tag_args --tag $tag"
    done

    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        --build-arg APP_VERSION="${VERSION}" \
        --target "$target" \
        $tag_args \
        $NO_CACHE_FLAG \
        --push \
        .
}

echo "🏗️  Building + pushing app image..."
build_and_push "app" "$APP_TAGS"

echo ""
echo "🏗️  Building + pushing worker image..."
build_and_push "worker" "$WORKER_TAGS"

echo ""
echo "✅ Multi-architecture build complete!"
echo ""
echo "📦 Images pushed to Docker Hub:"
for tag in $APP_TAGS; do
    echo "   $tag"
done
for tag in $WORKER_TAGS; do
    echo "   $tag"
done
echo ""
echo "🔍 Supported architectures:"
echo "   - linux/amd64 (x86_64)"
echo "   - linux/arm64 (aarch64)"
echo ""
if [ "$VERSION" != "latest" ]; then
    echo "📥 Pull specific version:"
    echo "   docker pull ${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:${VERSION}"
    echo "   docker pull ${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:${VERSION}"
    echo ""
    echo "📥 Or pull latest:"
fi
echo "   docker pull ${DOCKERHUB_USERNAME}/${APP_IMAGE_NAME}:latest"
echo "   docker pull ${DOCKERHUB_USERNAME}/${WORKER_IMAGE_NAME}:latest"
echo "   (will automatically select the correct architecture)"
echo ""
echo "🎉 Done!"
