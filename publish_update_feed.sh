#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euo pipefail

# Pushes stable/<platform>/<arch>/latest.json to the update-feed branch so
# a running app can see that a newer rolling build exists. Lives in this
# same repo (no HolboxAI/boxcode-ide-versions) because the IDE already
# fetches ${updateUrl}/${quality}/${platform}/${arch}/latest.json.

if [[ -z "${RELEASE_VERSION:-}" || -z "${VSCODE_ARCH:-}" || -z "${VSCODE_QUALITY:-}" ]]; then
  echo "RELEASE_VERSION, VSCODE_ARCH, and VSCODE_QUALITY are required"
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  echo "Will not publish the update feed because no GITHUB_TOKEN is set"
  exit 0
fi

GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN}}"
REPO="${GITHUB_REPOSITORY:-HolboxAI/boxcode-ide}"
TAG="${UPDATE_RELEASE_TAG:-macos-dev-latest}"
FEED_BRANCH="${UPDATE_FEED_BRANCH:-update-feed}"
APP_NAME="${APP_NAME:-Boxcode}"
OS_NAME="${OS_NAME:-osx}"
GH_HOST="${GH_HOST:-github.com}"

if [[ "${OS_NAME}" != "osx" ]]; then
  echo "publish_update_feed.sh currently only writes the macOS darwin feed"
  exit 0
fi

ASSET_NAME="${APP_NAME}-darwin-${VSCODE_ARCH}-${RELEASE_VERSION}.zip"
VERSION_PATH="${VSCODE_QUALITY}/darwin/${VSCODE_ARCH}"
URL="https://${GH_HOST}/${REPO}/releases/download/${TAG}/${ASSET_NAME}"

if [[ ! -f "assets/${ASSET_NAME}" ]]; then
  echo "Missing assets/${ASSET_NAME}"
  exit 1
fi

if [[ ! -f "assets/${ASSET_NAME}.sha1" || ! -f "assets/${ASSET_NAME}.sha256" ]]; then
  echo "Checksums missing; running prepare_checksums.sh"
  ./prepare_checksums.sh
fi

sha1hash=$( awk '{ print $1 }' "assets/${ASSET_NAME}.sha1" )
sha256hash=$( awk '{ print $1 }' "assets/${ASSET_NAME}.sha256" )
if [[ -z "${BUILD_SOURCEVERSION:-}" ]]; then
  if command -v sha1sum >/dev/null 2>&1; then
    BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1 )
  else
    BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | shasum -a 1 | cut -d' ' -f1 )
  fi
fi
timestamp=$( node -e 'console.log(Date.now())' )

transformVersion() {
  local version parts
  version="${1%-insider}"
  IFS='.' read -r -a parts <<< "${version}"
  parts[2]="$((10#${parts[2]}))"
  version="${parts[0]}.${parts[1]}.${parts[2]}.0"
  if [[ "${1}" == *-insider ]]; then
    version="${version}-insider"
  fi
  echo "${version}"
}

productVersion="$( transformVersion "${RELEASE_VERSION}" )"

JSON_DATA=$( jq -n \
  --arg url "${URL}" \
  --arg name "${RELEASE_VERSION}" \
  --arg version "${BUILD_SOURCEVERSION}" \
  --arg productVersion "${productVersion}" \
  --arg hash "${sha1hash}" \
  --arg timestamp "${timestamp}" \
  --arg sha256hash "${sha256hash}" \
  '{url:$url,name:$name,version:$version,productVersion:$productVersion,hash:$hash,timestamp:$timestamp,sha256hash:$sha256hash}' )

WORKDIR="$( mktemp -d )"
cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

git clone --depth 1 "https://x-access-token:${GITHUB_TOKEN}@${GH_HOST}/${REPO}.git" "${WORKDIR}/repo"
cd "${WORKDIR}/repo"

if git fetch origin "${FEED_BRANCH}:${FEED_BRANCH}" 2>/dev/null; then
  git checkout "${FEED_BRANCH}"
else
  git checkout --orphan "${FEED_BRANCH}"
  git rm -rf --ignore-unmatch . >/dev/null 2>&1 || true
fi

mkdir -p "${VERSION_PATH}"
printf '%s\n' "${JSON_DATA}" > "${VERSION_PATH}/latest.json"

git add "${VERSION_PATH}/latest.json"
if git diff --cached --quiet; then
  echo "Update feed already has ${RELEASE_VERSION}"
  exit 0
fi

git -c user.name="shivam-holboxai" -c user.email="shivam@holbox.ai" \
  commit -m "CI: ${VERSION_PATH} ${RELEASE_VERSION}"

git push origin "HEAD:${FEED_BRANCH}"
echo "Published ${VERSION_PATH}/latest.json for ${RELEASE_VERSION}"
