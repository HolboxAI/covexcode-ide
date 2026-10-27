#!/usr/bin/env bash
# Start the packaged agent and complete one ACP initialize round trip.
# Catches a sidecar that is present and executable but cannot actually serve
# ACP (wrong architecture, missing runtime library, corrupted build).
set -euo pipefail

if [[ "${SHOULD_BUILD_SIDECAR:-yes}" == "no" ]]; then
	echo "Skipping ACP smoke test (SHOULD_BUILD_SIDECAR=no)"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${OS_NAME:-}:${VSCODE_ARCH:-}" in
	osx:arm64|windows:x64|linux:x64|linux:arm64) ;;
	*)
		echo "No bundled agent expected for ${OS_NAME:-unknown}-${VSCODE_ARCH:-unknown}; skipping ACP smoke test"
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

BINARY="${APP_DIR}/extensions/covexcode-agent/resources/bin/covexcode"
if [[ "${OS_NAME}" == "windows" ]]; then
	BINARY="${BINARY}.exe"
fi
if [[ ! -x "${BINARY}" && "${OS_NAME}" != "windows" ]]; then
	echo "Bundled agent is missing or not executable at ${BINARY}" >&2
	exit 1
fi
if [[ ! -f "${BINARY}" ]]; then
	echo "Bundled agent is missing at ${BINARY}" >&2
	exit 1
fi

node "${ROOT}/test/sidecar-acp-smoke.mjs" "${BINARY}"
