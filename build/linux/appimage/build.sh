#!/usr/bin/env bash

set -ex

CALLER_DIR=$( pwd )

cd "$( dirname "${BASH_SOURCE[0]}" )"

if [[ "${VSCODE_ARCH}" == "x64" ]]; then
  GITHUB_RESPONSE=$( curl --silent --location "https://api.github.com/repos/AppImage/pkg2appimage/releases/latest" )
  APPIMAGE_URL=$( echo "${GITHUB_RESPONSE}" | jq --raw-output '.assets | map(select( .name | test("x86_64.AppImage(?!.zsync)"))) | map(.browser_download_url)[0]' )

  if [[ -z "${APPIMAGE_URL}" ]]; then
    echo "The url for pkg2appimage.AppImage hasn't been found"
    exit 1
  fi

  wget -c "${APPIMAGE_URL}" -O pkg2appimage.AppImage

  chmod +x ./pkg2appimage.AppImage

  ./pkg2appimage.AppImage --appimage-extract && mv ./squashfs-root ./pkg2appimage.AppDir

  # add update's url
  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    sed -i 's/generate_type2_appimage/generate_type2_appimage -u "gh-releases-zsync|HolboxAI|boxcode-ide-insiders|latest|*.AppImage.zsync"/' pkg2appimage.AppDir/AppRun
  else
    sed -i 's/generate_type2_appimage/generate_type2_appimage -u "gh-releases-zsync|HolboxAI|boxcode-ide|latest|*.AppImage.zsync"/' pkg2appimage.AppDir/AppRun
  fi
  # remove check so build in docker can succeed
  sed -i 's/grep docker/# grep docker/' pkg2appimage.AppDir/usr/share/pkg2appimage/functions.sh

  APP_NAME_LC="$( echo "${APP_NAME}" | awk '{print tolower($0)}' )"

  # The .deb names its desktop icon after product.json's linuxIconName
  # ("boxcode-ide"), not APP_NAME_LC ("boxcode") -- see prepare_vscode.sh.
  # Substituting the icon from APP_NAME_LC produced a path the .deb never
  # installs, so the recipe's `cp usr/share/pixmaps/<icon>.png` aborted the
  # whole prepare_assets run and no .deb/.rpm/AppImage ever got uploaded.
  # Read the same source of truth the .deb uses so the recipe finds the file
  # that is actually there. CALLER_DIR is the vscode/ checkout this script is
  # sourced from (see build/linux/prepare_assets.sh).
  LINUX_ICON_NAME="$( jq -r '.linuxIconName' "${CALLER_DIR}/product.json" )"
  if [[ -z "${LINUX_ICON_NAME}" || "${LINUX_ICON_NAME}" == "null" ]]; then
    LINUX_ICON_NAME="${BINARY_NAME}"
  fi
  sed -i "s|@@ICON@@|${LINUX_ICON_NAME}|g" recipe.yml

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    sed -i "s|@@APP_NAME@@|${APP_NAME}-Insiders|g" recipe.yml
    sed -i "s|@@BINARY_NAME@@|${BINARY_NAME}|g" recipe.yml
  else
    sed -i "s|@@APP_NAME@@|${APP_NAME}|g" recipe.yml
    sed -i "s|@@BINARY_NAME@@|${BINARY_NAME}|g" recipe.yml
  fi

  # workaround that enforces x86 ARCH for pkg2appimage having /__w/vscodium/vscodium/build/linux/appimage/VSCodium/VSCodium.AppDir/usr/share/codium/resources/app/node_modules/rc/index.js is of architecture armhf
  export ARCH=x86_64
  bash -ex pkg2appimage.AppDir/AppRun recipe.yml

  rm -f pkg2appimage-*.AppImage
  rm -rf pkg2appimage.AppDir
  rm -rf VSCodium*
fi

cd "${CALLER_DIR}"
