#!/usr/bin/env bash
# Verify that the bundled agent survived staging/packaging.
#
# prepare_sidecar.sh verifies the download before copying. This second check
# runs against the packaged app tree and catches a missing executable, a lost
# exec bit, a stale version.json, or a binary that was replaced after staging.
set -euo pipefail

if [[ "${SHOULD_BUILD_SIDECAR:-yes}" == "no" ]]; then
	echo "Skipping sidecar verification (SHOULD_BUILD_SIDECAR=no)"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${OS_NAME:-}:${VSCODE_ARCH:-}" in
	osx:arm64)    expected_prefix="darwin-arm64" ;;
	windows:x64)  expected_prefix="win32-x64" ;;
	linux:x64)    expected_prefix="linux-x64" ;;
	linux:arm64)  expected_prefix="linux-arm64" ;;
	*)
		echo "No bundled agent expected for ${OS_NAME:-unknown}-${VSCODE_ARCH:-unknown}; skipping verification"
		exit 0
		;;
esac

APP_DIR="${SIDECAR_APP_DIR:-}"
if [[ -z "${APP_DIR}" ]]; then
	case "${OS_NAME:-}" in
		osx)
			NAME_LONG="$(node -p "require('${ROOT}/vscode/product.json').nameLong")"
			APP_DIR="${ROOT}/VSCode-darwin-${VSCODE_ARCH}/${NAME_LONG}.app/Contents/Resources/app"
			;;
		windows)
			APP_DIR="${ROOT}/VSCode-win32-${VSCODE_ARCH}/resources/app"
			;;
		linux)
			APP_DIR="${ROOT}/VSCode-linux-${VSCODE_ARCH}/resources/app"
			;;
	esac
fi

BIN_DIR="${APP_DIR}/extensions/covexcode-agent/resources/bin"
BINARY="${BIN_DIR}/covexcode"
if [[ "${OS_NAME}" == "windows" ]]; then
	BINARY="${BIN_DIR}/covexcode.exe"
fi

if [[ ! -f "${BINARY}" ]]; then
	echo "Bundled agent missing at ${BINARY}" >&2
	exit 1
fi
if [[ "${OS_NAME}" != "windows" && ! -x "${BINARY}" ]]; then
	echo "Bundled agent is not executable at ${BINARY}" >&2
	exit 1
fi
if [[ ! -f "${BIN_DIR}/version.json" ]]; then
	echo "Bundled agent manifest missing at ${BIN_DIR}/version.json" >&2
	exit 1
fi

fields="$(node -e '
	const fs = require("fs");
	const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
	if (m.schemaVersion !== 1 || m.protocolVersion !== 1 || !/^[0-9a-f]{64}$/.test(m.sha256 || "")) {
		process.exit(3);
	}
	process.stdout.write([m.agentVersion, m.target, m.sha256, String(m.size)].join("\t"));
' "${BIN_DIR}/version.json")" || {
	echo "Bundled agent manifest is invalid at ${BIN_DIR}/version.json" >&2
	exit 1
}

IFS=$'\t' read -r agent_version target expected_sha expected_size <<<"${fields}"
if [[ "${target}" != "${expected_prefix}" && "${target}" != "${expected_prefix}-"* ]]; then
	echo "Bundled agent target ${target} does not match ${expected_prefix}" >&2
	exit 1
fi

actual_sha="$(node -e '
	const crypto = require("crypto");
	const fs = require("fs");
	process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "${BINARY}")"
actual_size="$(node -e 'process.stdout.write(String(require("fs").statSync(process.argv[1]).size))' "${BINARY}")"

if [[ "${actual_sha}" != "${expected_sha}" || "${actual_size}" != "${expected_size}" ]]; then
	echo "Bundled agent does not match version.json at ${BINARY}" >&2
	exit 1
fi

echo "Verified bundled agent ${agent_version} (${target}) at ${BINARY}"
