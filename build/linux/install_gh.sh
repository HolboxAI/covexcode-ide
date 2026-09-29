#!/usr/bin/env bash

set -ex

# Prefer a gh already on PATH (many runners ship one) so we do not burn
# GitHub API quota just to reinstall the same binary.
if command -v gh >/dev/null 2>&1; then
  gh --version
  exit 0
fi

GH_ARCH="amd64"

# Unauthenticated api.github.com calls often return null under shared
# Actions IP rate limits; pass GITHUB_TOKEN when present.
AUTH_HEADER=()
if [[ -n "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]]; then
  AUTH_HEADER=( -H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN}}" )
fi

TAG=""
for i in {1..5}; do
  TAG=$( curl --retry 12 --retry-delay 30 "${AUTH_HEADER[@]}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/cli/cli/releases/latest" 2>/dev/null \
    | jq --raw-output '.tag_name' )

  if [[ $? == 0 && -n "${TAG}" && "${TAG}" != "null" ]]; then
    break
  fi

  if [[ $i == 5 ]]; then
    echo "GH install via GitHub API failed; falling back to apt" >&2
    TAG=""
    break
  fi

  echo "GH install failed $i, trying again..."
  sleep $(( 15 * (i + 1)))
done

if [[ -z "${TAG}" || "${TAG}" == "null" ]]; then
  sudo apt-get update -y
  sudo apt-get install -y gh
  gh --version
  exit 0
fi

VERSION="${TAG#v}"

curl --retry 12 --retry-delay 120 -sSL \
  "https://github.com/cli/cli/releases/download/${TAG}/gh_${VERSION}_linux_${GH_ARCH}.tar.gz" \
  -o "gh_${VERSION}_linux_${GH_ARCH}.tar.gz"

tar xf "gh_${VERSION}_linux_${GH_ARCH}.tar.gz"

cp "gh_${VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/

gh --version
