#!/usr/bin/env bash
# Ubuntu archive drops connections under load (two Linux matrices at once
# after stacked main merges). apt-get's default is one try; exit 100 then
# fails the whole workflow even though compile already succeeded.

set -euo pipefail
set -x

apt_retry() {
  local attempt=1
  local max=5
  while true; do
    if sudo apt-get -o Acquire::Retries=5 "$@"; then
      return 0
    fi
    if [[ "${attempt}" -ge "${max}" ]]; then
      echo "apt-get $* failed after ${max} attempts" >&2
      return 1
    fi
    echo "apt-get failed (attempt ${attempt}/${max}), retrying..." >&2
    sleep $(( 15 * attempt ))
    attempt=$(( attempt + 1 ))
  done
}

apt_retry update -y
apt_retry install -y libkrb5-dev

if [[ "${VSCODE_ARCH}" == "arm64" ]]; then
  apt_retry install -y gcc-aarch64-linux-gnu g++-aarch64-linux-gnu crossbuild-essential-arm64
fi
