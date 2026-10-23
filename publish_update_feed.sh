#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euo pipefail

# Pushes stable/<platform>/<arch>[/<target>]/latest.json to the update-feed
# branch so a running app can see that a newer rolling build exists. Lives in
# this same repo (no HolboxAI/covexcode-ide-versions) because the IDE already
# fetches ${updateUrl}/${quality}/${platform}/${arch}/latest.json.
#
# Platforms:
#   osx      -> darwin/<arch>          .zip       (Squirrel.Mac)
#   linux    -> linux/<node arch>      .tar.gz    (built-in tar updater)
#   windows  -> win32/<arch>/user      Inno user  (built-in EXE updater)
#               win32/<arch>/system    Inno system
#               win32/<arch>/msi       MSI        (built-in MSI updater)
#
# Windows archive (.zip) installs cannot update themselves (Win32UpdateService
# treats UpdateType.Archive as non-updatable), so no archive feed is written.

if [[ -z "${RELEASE_VERSION:-}" || -z "${VSCODE_ARCH:-}" || -z "${VSCODE_QUALITY:-}" ]]; then
  echo "RELEASE_VERSION, VSCODE_ARCH, and VSCODE_QUALITY are required"
  exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  echo "Will not publish the update feed because no GITHUB_TOKEN is set"
  exit 0
fi

GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN}}"
REPO="${GITHUB_REPOSITORY:-HolboxAI/covexcode-ide}"
FEED_BRANCH="${UPDATE_FEED_BRANCH:-update-feed}"
APP_NAME="${APP_NAME:-Covexcode}"
OS_NAME="${OS_NAME:-osx}"
GH_HOST="${GH_HOST:-github.com}"
TAG="${UPDATE_RELEASE_TAG:-${RELEASE_VERSION}}"

case "${OS_NAME}" in
  osx)
    PLATFORM="darwin"
    FEED_ARCH="${VSCODE_ARCH}"
    ;;
  linux)
    PLATFORM="linux"
    # Node reports process.arch=ppc64 for the ppc64le build, and the app
    # builds the feed path from process.arch. The VSCode build arch is
    # ppc64le, so translate it for the feed path only.
    case "${VSCODE_ARCH}" in
      ppc64le) FEED_ARCH="ppc64" ;;
      *) FEED_ARCH="${VSCODE_ARCH}" ;;
    esac
    ;;
  windows)
    PLATFORM="win32"
    FEED_ARCH="${VSCODE_ARCH}"
    ;;
  *)
    echo "publish_update_feed.sh does not support OS_NAME=${OS_NAME}"
    exit 0
    ;;
esac

if [[ -z "${BUILD_SOURCEVERSION:-}" ]]; then
  if command -v sha1sum >/dev/null 2>&1; then
    BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1 )
  else
    BUILD_SOURCEVERSION=$( echo "${RELEASE_VERSION/-*/}" | shasum -a 1 | cut -d' ' -f1 )
  fi
fi
timestamp=$( node -e 'console.log(Date.now())' )

transformVersion() {
  local version
  version="${1%-insider}"
  if [[ "${1}" == *-insider ]]; then
    version="${version}-insider"
  fi
  echo "${version}"
}

productVersion="$( transformVersion "${RELEASE_VERSION}" )"

ASSETS_DIR="$( pwd )/assets"

sha1_of() {
  local file="$1"
  if [[ -f "${file}.sha1" ]]; then
    awk '{ print $1 }' "${file}.sha1"
  elif command -v sha1sum >/dev/null 2>&1; then
    sha1sum "${file}" | awk '{ print $1 }'
  else
    shasum -a 1 "${file}" | awk '{ print $1 }'
  fi
}

sha256_of() {
  local file="$1"
  if [[ -f "${file}.sha256" ]]; then
    awk '{ print $1 }' "${file}.sha256"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{ print $1 }'
  else
    shasum -a 256 "${file}" | awk '{ print $1 }'
  fi
}

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

publish_entry() {
  local version_path="$1"
  local asset_name="$2"
  local asset_path="${ASSETS_DIR}/${asset_name}"

  if [[ ! -f "${asset_path}" ]]; then
    echo "Missing ${asset_path}; skipping ${version_path}"
    return 0
  fi

  local url="https://${GH_HOST}/${REPO}/releases/download/${TAG}/${asset_name}"
  local sha1hash sha256hash
  sha1hash="$( sha1_of "${asset_path}" )"
  sha256hash="$( sha256_of "${asset_path}" )"

  mkdir -p "${version_path}"
  jq -n \
    --arg url "${url}" \
    --arg name "${RELEASE_VERSION}" \
    --arg version "${BUILD_SOURCEVERSION}" \
    --arg productVersion "${productVersion}" \
    --arg hash "${sha1hash}" \
    --arg timestamp "${timestamp}" \
    --arg sha256hash "${sha256hash}" \
    '{url:$url,name:$name,version:$version,productVersion:$productVersion,hash:$hash,timestamp:$timestamp,sha256hash:$sha256hash}' \
    > "${version_path}/latest.json"

  echo "Published ${version_path}/latest.json for ${RELEASE_VERSION}"
}

if [[ "${OS_NAME}" == "windows" ]]; then
  # These three install types pick different feed paths in
  # Win32UpdateService.buildUpdateFeedUrl().
  publish_entry "${VSCODE_QUALITY}/${PLATFORM}/${FEED_ARCH}/user" \
    "${APP_NAME}UserSetup-${VSCODE_ARCH}-${RELEASE_VERSION}.exe"
  publish_entry "${VSCODE_QUALITY}/${PLATFORM}/${FEED_ARCH}/system" \
    "${APP_NAME}Setup-${VSCODE_ARCH}-${RELEASE_VERSION}.exe"

  # The "updates-disabled" MSI exists for builds that must not self-update;
  # never point the feed at it.
  msi_path="$( find "${ASSETS_DIR}" -maxdepth 1 -type f \
    -name "${APP_NAME}-${VSCODE_ARCH}-*${RELEASE_VERSION}.msi" \
    ! -name "*updates-disabled*" -print -quit )"
  if [[ -n "${msi_path}" ]]; then
    publish_entry "${VSCODE_QUALITY}/${PLATFORM}/${FEED_ARCH}/msi" "$( basename "${msi_path}" )"
  else
    echo "No updater-enabled MSI found; skipping the MSI feed"
  fi
else
  if [[ "${OS_NAME}" == "osx" ]]; then
    ASSET_EXT="zip"
  else
    ASSET_EXT="tar.gz"
  fi
  publish_entry "${VSCODE_QUALITY}/${PLATFORM}/${FEED_ARCH}" \
    "${APP_NAME}-${PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.${ASSET_EXT}"
fi

git add -A
if git diff --cached --quiet; then
  echo "Update feed already has ${RELEASE_VERSION}"
  exit 0
fi

git -c user.name="shivam-holboxai" -c user.email="shivam@holbox.ai" \
  commit -m "CI: update feed ${OS_NAME}/${FEED_ARCH} ${RELEASE_VERSION}"

git push origin "HEAD:${FEED_BRANCH}"
echo "Published update feed for ${RELEASE_VERSION}"
