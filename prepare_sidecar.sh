#!/usr/bin/env bash
# Stage the pinned agent runtime inside the built-in extension.
#
# The IDE must not depend on a user-installed `covexcode` binary. This script
# downloads the artifact recorded in agent.lock.json, verifies its SHA-256 and
# places it where the extension can resolve it with
# context.asAbsolutePath('resources/bin/covexcode').
#
# Call this after prepare_vscode.sh has copied the extension into vscode/ and
# before the platform packaging/signing step. Set SHOULD_BUILD_SIDECAR=no to
# skip it for local or PR compile-only builds.
set -euo pipefail

if [[ "${SHOULD_BUILD_SIDECAR:-yes}" == "no" ]]; then
	echo "Skipping sidecar staging (SHOULD_BUILD_SIDECAR=no)"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="${ROOT}/agent.lock.json"

if [[ ! -f "${LOCK}" ]]; then
	echo "agent.lock.json not found at ${LOCK}" >&2
	exit 1
fi

# Stage into the packaged app tree, not the vscode source tree: the app tree
# is what the installers and the signed .app actually contain. SIDECAR_APP_DIR
# is an explicit override for tests/local builds.
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

EXTENSION="${APP_DIR}/extensions/covexcode-agent"
DEST_DIR="${EXTENSION}/resources/bin"
if [[ -z "${APP_DIR}" || ! -d "${EXTENSION}" ]]; then
	echo "covexcode-agent extension not found at ${EXTENSION:-<unknown>}; run the platform packing step first" >&2
	exit 1
fi

case "${OS_NAME:-}:${VSCODE_ARCH:-}" in
	osx:arm64)      key="darwin-arm64" ;;
	windows:x64)    key="win32-x64" ;;
	linux:x64)      key="linux-x64-musl" ;;
	linux:arm64)    key="linux-arm64-musl" ;;
	*)
		echo "No bundled agent for ${OS_NAME:-unknown}-${VSCODE_ARCH:-unknown}; the IDE will use its external-CLI fallback" >&2
		exit 0
		;;
esac

read_lock_field() {
	node -e '
		const lock = require(process.argv[1]);
		const artifact = lock.artifacts[process.argv[2]];
		if (!artifact) process.exit(3);
		process.stdout.write([artifact.asset, artifact.sha256, artifact.size].join("\t"));
	' "${LOCK}" "$1"
}

# Linux prefers a static musl sidecar. Until the first release that carries
# musl assets, fall back to the gnu build recorded in the lock.
if ! fields="$(read_lock_field "${key}")"; then
	if [[ "${key}" == "linux-x64-musl" ]]; then
		key="linux-x64"
	elif [[ "${key}" == "linux-arm64-musl" ]]; then
		key="linux-arm64"
	fi
	if ! fields="$(read_lock_field "${key}")"; then
		echo "No pinned agent artifact for target ${key}" >&2
		exit 1
	fi
fi

IFS=$'\t' read -r asset expected_sha expected_size <<<"${fields}"
RELEASE_TAG="$(node -e 'process.stdout.write(require(process.argv[1]).releaseTag)' "${LOCK}")"
REPOSITORY="$(node -e 'process.stdout.write(require(process.argv[1]).repository)' "${LOCK}")"

binary_name="covexcode"
if [[ "${key}" == win32-* ]]; then
	binary_name="covexcode.exe"
fi

if [[ -f "${DEST_DIR}/version.json" && -f "${DEST_DIR}/${binary_name}" ]]; then
	staged_sha="$(node -e '
		const fs = require("fs");
		process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).sha256 || "");
	' "${DEST_DIR}/version.json")"
	if [[ "${staged_sha}" == "${expected_sha}" ]]; then
		echo "Bundled agent already staged (${key}, ${RELEASE_TAG})"
		exit 0
	fi
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

if [[ -n "${SIDECAR_ASSET_DIR:-}" && -f "${SIDECAR_ASSET_DIR}/${asset}" ]]; then
	cp "${SIDECAR_ASSET_DIR}/${asset}" "${TMP_DIR}/${asset}"
else
	url="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/${asset}"
	echo "Downloading ${url}"
	curl -fL --retry 3 --retry-delay 2 -o "${TMP_DIR}/${asset}" "${url}"
fi

actual_sha="$(node -e '
	const crypto = require("crypto");
	const fs = require("fs");
	process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "${TMP_DIR}/${asset}")"
actual_size="$(node -e 'process.stdout.write(String(require("fs").statSync(process.argv[1]).size))' "${TMP_DIR}/${asset}")"

if [[ "${actual_sha}" != "${expected_sha}" ]]; then
	echo "SHA-256 mismatch for ${asset}: expected ${expected_sha}, got ${actual_sha}" >&2
	exit 1
fi
if [[ "${actual_size}" != "${expected_size}" ]]; then
	echo "size mismatch for ${asset}: expected ${expected_size}, got ${actual_size}" >&2
	exit 1
fi

mkdir -p "${DEST_DIR}"
cp "${TMP_DIR}/${asset}" "${DEST_DIR}/${binary_name}"
chmod 755 "${DEST_DIR}/${binary_name}"

node -e '
	const fs = require("fs");
	const lock = require(process.argv[1]);
	const artifact = lock.artifacts[process.argv[2]];
	const out = process.argv[3];
	fs.writeFileSync(out, JSON.stringify({
		schemaVersion: 1,
		agentVersion: lock.agentVersion,
		protocolVersion: lock.protocolVersion,
		target: process.argv[2],
		asset: artifact.asset,
		sha256: artifact.sha256,
		size: artifact.size,
	}, null, 2) + "\n");
' "${LOCK}" "${key}" "${DEST_DIR}/version.json"

echo "Staged bundled agent ${RELEASE_TAG} (${key}) at ${DEST_DIR}/${binary_name}"
