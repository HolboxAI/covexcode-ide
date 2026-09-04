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
  # vscode/build/gulpfile.vscode.ts), not nameShort. boxcode-ide's nameShort
  # ("Boxcode") and nameLong ("Boxcode IDE") differ, unlike VSCodium's
  # (which are identical), so this must use nameLong to find the bundle.
  NAME_LONG="$( node -p "require(\"./vscode/product.json\").nameLong" )"
  TUNNEL_APPLICATION_NAME="$( node -p "require(\"./vscode/product.json\").tunnelApplicationName" )"

  mkdir -p "vscode-cli"

  cd "vscode-cli"

  if [[ "${OS_NAME}" == "osx" ]]; then
    cp "../VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/${NAME_LONG}.app/Contents/Resources/app/bin/${TUNNEL_APPLICATION_NAME}" "${APPLICATION_NAME}"
  elif [[ "${OS_NAME}" == "windows" ]]; then
    cp "../VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/bin/${TUNNEL_APPLICATION_NAME}.exe" "${APPLICATION_NAME}.exe"
  else
    cp "../VSCode-${VSCODE_PLATFORM}-${VSCODE_ARCH}/bin/${TUNNEL_APPLICATION_NAME}" "${APPLICATION_NAME}"
  fi

  tar czf "../assets/${APP_NAME_LC}-cli-${VSCODE_PLATFORM}-${VSCODE_ARCH}-${RELEASE_VERSION}.tar.gz" .

  cd ..
fi

if [[ "${OS_NAME}" != "windows" ]]; then
  ./prepare_checksums.sh
fi
