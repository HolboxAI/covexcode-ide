#!/usr/bin/env bash
# Offline test for verify_sidecar.sh. No release download, no network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

APP="${TMP}/app"
BIN_DIR="${APP}/extensions/covexcode-agent/resources/bin"
mkdir -p "${BIN_DIR}"
printf '#!/bin/sh\nexit 0\n' > "${BIN_DIR}/covexcode"
chmod +x "${BIN_DIR}/covexcode"

sha="$(node -e '
	const crypto = require("crypto");
	const fs = require("fs");
	process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "${BIN_DIR}/covexcode")"
size="$(node -e 'process.stdout.write(String(require("fs").statSync(process.argv[1]).size))' "${BIN_DIR}/covexcode")"

node -e '
	const fs = require("fs");
	fs.writeFileSync(process.argv[1], JSON.stringify({
		schemaVersion: 1,
		agentVersion: "1.11.92",
		protocolVersion: 1,
		target: "darwin-arm64",
		asset: "covexcode-macos-aarch64",
		sha256: process.argv[2],
		size: Number(process.argv[3]),
	}, null, 2) + "\n");
' "${BIN_DIR}/version.json" "${sha}" "${size}"

SIDECAR_APP_DIR="${APP}" OS_NAME=osx VSCODE_ARCH=arm64 "${ROOT}/verify_sidecar.sh" >/dev/null

printf 'corrupt' >> "${BIN_DIR}/covexcode"
if SIDECAR_APP_DIR="${APP}" OS_NAME=osx VSCODE_ARCH=arm64 "${ROOT}/verify_sidecar.sh" >/dev/null 2>&1; then
	echo "verify_sidecar.sh accepted a corrupted binary" >&2
	exit 1
fi

SIDECAR_APP_DIR="${APP}" OS_NAME=linux VSCODE_ARCH=ppc64le "${ROOT}/verify_sidecar.sh" >/dev/null
SIDECAR_APP_DIR="${APP}" SHOULD_BUILD_SIDECAR=no OS_NAME=osx VSCODE_ARCH=arm64 "${ROOT}/verify_sidecar.sh" >/dev/null

echo "sidecar layout tests passed"
