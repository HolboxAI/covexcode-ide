#!/usr/bin/env bash
# shellcheck disable=SC1091

set -e

APP_NAME_LC="$( echo "${APP_NAME}" | awk '{print tolower($0)}' )"

mkdir -p assets

if [[ "${OS_NAME}" == "osx" ]]; then
  . ./build/osx/prepare_assets.sh

  VSCODE_PLATFORM="darwin"
elif [[ "${OS_NAME}" == "windows" ]]; then
  . ./build/windows/prepare_assets.sh

  VSCODE_PLATFORM="win32"
else
  . ./build/linux/prepare_assets.sh

  VSCODE_PLATFORM="linux"
fi

if [[ "${SHOULD_BUILD_REH}" != "no" ]]; then
  echo "Building and moving REH"
  cd "vscode-reh-${VSCODE_PLATFORM}-${VSCODE_ARCH}"
  tar czf "../assets/${APP_NAME_LC}-reh-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .
  cd ..
fi

if [[ "${SHOULD_BUILD_REH_WEB}" != "no" ]]; then
  echo "Building and moving REH-web"
  cd "vscode-reh-web-${VSCODE_PLATFORM}-${VSCODE_ARCH}"
  tar czf "../assets/${APP_NAME_LC}-reh-web-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .
  cd ..
fi

set -ex

if [[ "${SHOULD_BUILD_CLI}" != "no" ]]; then
  echo "Building and moving CLI"

  APPLICATION_NAME="$( node -p "require(\"./vscode/product.json\").applicationName" )"
  # See build_cli.sh: the macOS .app bundle is named after nameLong (per
  # vscode/build/gulpfile.vscode.ts), not nameShort. covexcode-ide's nameShort
  # ("Covexcode") and nameLong ("Covexcode IDE") differ, unlike VSCodium's
  # (which are identical), so this must use nameLong to find the bundle.
  NAME_LONG="$( node -p "require(\"./vscode/product.json\").nameLong" )"
  TUNNEL_APPLICATION_NAME="$( node -p "require(\"./vscode/product.json\").tunnelApplicationName" )"

  if [[ "${OS_NAME}" == "osx" ]]; then
    CLI_SRC="../VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/${NAME_LONG}.app/Contents/Resources/app/bin/${TUNNEL_APPLICATION_NAME}"
    CLI_DST="${APPLICATION_NAME}"
  elif [[ "${OS_NAME}" == "windows" ]]; then
    CLI_SRC="../VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/bin/${TUNNEL_APPLICATION_NAME}.exe"
    CLI_DST="${APPLICATION_NAME}.exe"
  else
    CLI_SRC="../VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/bin/${TUNNEL_APPLICATION_NAME}"
    CLI_DST="${APPLICATION_NAME}"
  fi

  # build_cli.sh only builds the tunnel CLI for arches it has a Rust target
  # for (Linux x64/arm64/ppc64le, macOS/Windows x64/arm64). riscv64 and
  # loong64 have no target yet, so the binary legitimately doesn't exist
  # there -- skip the CLI tarball rather than failing the whole job.
  if [[ ! -f "${CLI_SRC}" ]]; then
    echo "Skipping CLI tarball: no tunnel CLI built for ${VSCODE_PLATFORM}-${VSCODE_ARCH} (no Rust target)"
  else
    mkdir -p "vscode-cli"

    cd "vscode-cli"

    cp "${CLI_SRC}" "${CLI_DST}"

    tar czf "../assets/${APP_NAME_LC}-cli-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .

    cd ..
  fi
fi

if [[ "${OS_NAME}" != "windows" ]]; then
  ./prepare_checksums.sh
fi
