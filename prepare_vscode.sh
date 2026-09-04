#!/usr/bin/env bash
# shellcheck disable=SC1091,2154

set -e

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  cp -rp src/insider/* vscode/
else
  cp -rp src/stable/* vscode/
fi

cp -f LICENSE vscode/LICENSE.txt

cd vscode || { echo "'vscode' dir not found"; exit 1; }

{ set +x; } 2>/dev/null

# {{{ product.json
cp product.json{,.bak}

setpath() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --arg 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath_json() {
  local jsonTmp
  { set +x; } 2>/dev/null
  jsonTmp=$( jq --argjson 'value' "${3}" "setpath(path(.${2}); \$value)" "${1}.json" )
  echo "${jsonTmp}" > "${1}.json"
  set -x
}

setpath "product" "checksumFailMoreInfoUrl" "https://go.microsoft.com/fwlink/?LinkId=828886"
setpath "product" "documentationUrl" "https://go.microsoft.com/fwlink/?LinkID=533484#vscode"
setpath_json "product" "extensionsGallery" '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'

setpath "product" "introductoryVideosUrl" "https://go.microsoft.com/fwlink/?linkid=832146"
setpath "product" "keyboardShortcutsUrlLinux" "https://go.microsoft.com/fwlink/?linkid=832144"
setpath "product" "keyboardShortcutsUrlMac" "https://go.microsoft.com/fwlink/?linkid=832143"
setpath "product" "keyboardShortcutsUrlWin" "https://go.microsoft.com/fwlink/?linkid=832145"
setpath "product" "licenseUrl" "https://github.com/HolboxAI/boxcode-ide/blob/main/LICENSE"
setpath_json "product" "linkProtectionTrustedDomains" '["https://open-vsx.org"]'
setpath "product" "releaseNotesUrl" "https://go.microsoft.com/fwlink/?LinkID=533483#vscode"
setpath "product" "reportIssueUrl" "https://github.com/HolboxAI/boxcode-ide/issues/new"
setpath "product" "requestFeatureUrl" "https://go.microsoft.com/fwlink/?LinkID=533482"
setpath "product" "tipsAndTricksUrl" "https://go.microsoft.com/fwlink/?linkid=852118"
setpath "product" "twitterUrl" "https://go.microsoft.com/fwlink/?LinkID=533687"

# P1: no boxcode-owned update server exists yet. Rather than point at
# VSCodium's update infrastructure (which is what would happen if these were
# left as-is), auto-update stays off by default until boxcode-ide stands up
# its own release feed. Set DISABLE_UPDATE=no once that exists, and swap the
# URLs below for a HolboxAI-owned versions feed at the same time.
if [[ "${DISABLE_UPDATE}" != "yes" ]]; then
  setpath "product" "updateUrl" "https://raw.githubusercontent.com/HolboxAI/boxcode-ide-versions/refs/heads/main"

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    setpath "product" "downloadUrl" "https://github.com/HolboxAI/boxcode-ide-insiders/releases"
  else
    setpath "product" "downloadUrl" "https://github.com/HolboxAI/boxcode-ide/releases"
  fi

  # if [[ "${OS_NAME}" == "windows" ]]; then
  #   setpath_json "product" "win32VersionedUpdate" "true"
  # fi
fi

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "product" "nameShort" "Boxcode - Insiders"
  setpath "product" "nameLong" "Boxcode IDE - Insiders"
  setpath "product" "applicationName" "boxcode-ide-insiders"
  setpath "product" "dataFolderName" ".boxcode-insiders"
  setpath "product" "linuxIconName" "boxcode-ide-insiders"
  setpath "product" "quality" "insider"
  setpath "product" "urlProtocol" "boxcode-insiders"
  setpath "product" "serverApplicationName" "boxcode-ide-server-insiders"
  setpath "product" "serverDataFolderName" ".boxcode-server-insiders"
  setpath "product" "darwinBundleIdentifier" "ai.holbox.BoxcodeInsiders"
  setpath "product" "win32AppUserModelId" "HolboxAI.BoxcodeInsiders"
  setpath "product" "win32DirName" "Boxcode Insiders"
  setpath "product" "win32MutexName" "boxcodeinsiders"
  setpath "product" "win32NameVersion" "Boxcode Insiders"
  setpath "product" "win32RegValueName" "BoxcodeInsiders"
  setpath "product" "win32ShellNameShort" "Boxcode Insiders"
  setpath "product" "win32AppId" "{{1ED69A3A-3504-4067-85F9-979AA8F0C8E0}"
  setpath "product" "win32x64AppId" "{{522B6135-0C01-457B-BB60-2C11F06215FA}"
  setpath "product" "win32arm64AppId" "{{A1BB72B4-F3E8-4280-B5F1-997ECB9CDBE1}"
  setpath "product" "win32UserAppId" "{{7D8C645F-6EBD-4E96-BD2B-4B73C49F7FBB}"
  setpath "product" "win32x64UserAppId" "{{EDC5C6B5-8097-425E-BF19-2C8A93935246}"
  setpath "product" "win32arm64UserAppId" "{{0323923F-6B49-4589-BFB4-77C984B1F291}"
  setpath "product" "tunnelApplicationName" "boxcode-ide-insiders-tunnel"
  setpath "product" "win32TunnelServiceMutex" "boxcodeinsiders-tunnelservice"
  setpath "product" "win32TunnelMutex" "boxcodeinsiders-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "BF823ADB-EB61-47B7-9E3E-78947B4522BB"
  setpath "product" "win32ContextMenu.arm64.clsid" "E458122F-D39E-4F72-A570-2F91CF615953"
else
  setpath "product" "nameShort" "Boxcode"
  setpath "product" "nameLong" "Boxcode IDE"
  setpath "product" "applicationName" "boxcode-ide"
  setpath "product" "linuxIconName" "boxcode-ide"
  setpath "product" "quality" "stable"
  setpath "product" "urlProtocol" "boxcode"
  setpath "product" "serverApplicationName" "boxcode-ide-server"
  setpath "product" "serverDataFolderName" ".boxcode-server"
  setpath "product" "darwinBundleIdentifier" "ai.holbox.Boxcode"
  setpath "product" "win32AppUserModelId" "HolboxAI.Boxcode"
  setpath "product" "win32DirName" "Boxcode"
  setpath "product" "win32MutexName" "boxcode"
  setpath "product" "win32NameVersion" "Boxcode"
  setpath "product" "win32RegValueName" "Boxcode"
  setpath "product" "win32ShellNameShort" "Boxcode"
  setpath "product" "win32AppId" "{{1BB64F8C-D6A1-4012-8856-19CBC142E7CE}"
  setpath "product" "win32x64AppId" "{{0A1CD48C-3BFA-4D4F-BFC8-3E432AC46414}"
  setpath "product" "win32arm64AppId" "{{6E25C63C-5501-42FC-BE37-FEFC69DA318C}"
  setpath "product" "win32UserAppId" "{{D42402AC-1340-4084-BAC3-387909BB4468}"
  setpath "product" "win32x64UserAppId" "{{FC6C829C-A360-4320-B78E-88B5974FE5D8}"
  setpath "product" "win32arm64UserAppId" "{{BFFCB1F9-FEF4-4E3B-960A-6A214E2797EC}"
  setpath "product" "tunnelApplicationName" "boxcode-ide-tunnel"
  setpath "product" "win32TunnelServiceMutex" "boxcode-tunnelservice"
  setpath "product" "win32TunnelMutex" "boxcode-tunnel"
  setpath "product" "win32ContextMenu.x64.clsid" "153DFF8C-5B51-4F05-8D58-73C44F595C20"
  setpath "product" "win32ContextMenu.arm64.clsid" "B0C0086C-1EBE-41D7-9145-AD3EF1D0F1F4"
fi

setpath_json "product" "tunnelApplicationConfig" '{}'

jsonTmp=$( jq -s '.[0] * .[1]' product.json ../product.json )
echo "${jsonTmp}" > product.json && unset jsonTmp

cat product.json
# }}}

# include common functions
. ../utils.sh

# {{{ apply patches

echo "APP_NAME=\"${APP_NAME}\""
echo "APP_NAME_LC=\"${APP_NAME_LC}\""
echo "ASSETS_REPOSITORY=\"${ASSETS_REPOSITORY}\""
echo "BINARY_NAME=\"${BINARY_NAME}\""
echo "GH_REPO_PATH=\"${GH_REPO_PATH}\""
echo "GLOBAL_DIRNAME=\"${GLOBAL_DIRNAME}\""
echo "ORG_NAME=\"${ORG_NAME}\""
echo "TUNNEL_APP_NAME=\"${TUNNEL_APP_NAME}\""

if [[ "${DISABLE_UPDATE}" == "yes" ]]; then
  mv ../patches/00-update-disable.patch.yet ../patches/00-update-disable.patch
fi

for file in ../patches/*.json; do
  if [[ -f "${file}" ]]; then
    apply_actions "${file}"
  fi
done

for file in ../patches/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  for file in ../patches/insider/*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

if [[ -d "../patches/${OS_NAME}/" ]]; then
  for file in "../patches/${OS_NAME}/"*.patch; do
    if [[ -f "${file}" ]]; then
      apply_patch "${file}"
    fi
  done
fi

for file in ../patches/user/*.patch; do
  if [[ -f "${file}" ]]; then
    apply_patch "${file}"
  fi
done
# }}}

set -x

# {{{ install dependencies
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [[ "${OS_NAME}" == "linux" ]]; then
  export VSCODE_SKIP_NODE_VERSION_CHECK=1

   if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
elif [[ "${OS_NAME}" == "windows" ]]; then
  if [[ "${npm_config_arch}" == "arm" ]]; then
    export npm_config_arm_version=7
  fi
else
  if [[ "${CI_BUILD}" != "no" ]]; then
    clang++ --version
  fi
fi

node build/npm/preinstall.ts

mv .npmrc .npmrc.bak
cp ../npmrc .npmrc

for i in {1..5}; do # try 5 times
  if [[ "${CI_BUILD}" != "no" && "${OS_NAME}" == "osx" ]]; then
    CXX=clang++ npm ci && break
  else
    npm ci && break
  fi

  if [[ $i == 5 ]]; then
    echo "Npm install failed too many times" >&2
    exit 1
  fi
  echo "Npm install failed $i, trying again..."

  sleep $(( 15 * (i + 1)))
done

mv .npmrc.bak .npmrc
# }}}

# package.json
cp package.json{,.bak}

setpath "package" "version" "${RELEASE_VERSION%-insider}"

replace 's|Microsoft Corporation|HolboxAI|' package.json

cp resources/server/manifest.json{,.bak}

if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
  setpath "resources/server/manifest" "name" "Boxcode - Insiders"
  setpath "resources/server/manifest" "short_name" "Boxcode - Insiders"
else
  setpath "resources/server/manifest" "name" "Boxcode"
  setpath "resources/server/manifest" "short_name" "Boxcode"
fi

# announcements
replace "s|\\[\\/\\* BUILTIN_ANNOUNCEMENTS \\*\\/\\]|$( tr -d '\n' < ../announcements-builtin.json )|" src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts

../undo_telemetry.sh

replace 's|Microsoft Corporation|HolboxAI|' build/lib/electron.ts
replace 's|([0-9]) Microsoft|\1 HolboxAI|' build/lib/electron.ts

if [[ "${OS_NAME}" == "linux" ]]; then
  # microsoft adds their apt repo to sources
  # unless the app name is code-oss
  # as we are renaming the application to boxcode
  # we need to edit a line in the post install template
  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    sed -i "s/code-oss/boxcode-ide-insiders/" resources/linux/debian/postinst.template
  else
    sed -i "s/code-oss/boxcode-ide/" resources/linux/debian/postinst.template
  fi

  # fix the packages metadata
  # code.appdata.xml
  sed -i 's|Visual Studio Code|Boxcode|g' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/HolboxAI/boxcode-ide#readme|' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com/home/home-screenshot-linux-lg.png||' resources/linux/code.appdata.xml
  sed -i 's|https://code.visualstudio.com|https://github.com/HolboxAI/boxcode-ide|' resources/linux/code.appdata.xml

  # control.template
  sed -i 's|Microsoft Corporation <vscode-linux@microsoft.com>|HolboxAI https://github.com/HolboxAI/boxcode-ide/graphs/contributors|'  resources/linux/debian/control.template
  sed -i 's|Visual Studio Code|Boxcode|g' resources/linux/debian/control.template
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/HolboxAI/boxcode-ide#readme|' resources/linux/debian/control.template
  sed -i 's|https://code.visualstudio.com|https://github.com/HolboxAI/boxcode-ide|' resources/linux/debian/control.template

  # code.spec.template
  sed -i 's|Microsoft Corporation|HolboxAI|' resources/linux/rpm/code.spec.template
  sed -i 's|Visual Studio Code Team <vscode-linux@microsoft.com>|HolboxAI https://github.com/HolboxAI/boxcode-ide/graphs/contributors|' resources/linux/rpm/code.spec.template
  sed -i 's|Visual Studio Code|Boxcode|' resources/linux/rpm/code.spec.template
  sed -i 's|https://code.visualstudio.com/docs/setup/linux|https://github.com/HolboxAI/boxcode-ide#readme|' resources/linux/rpm/code.spec.template
  sed -i 's|https://code.visualstudio.com|https://github.com/HolboxAI/boxcode-ide|' resources/linux/rpm/code.spec.template

  # snapcraft.yaml
  sed -i 's|Visual Studio Code|Boxcode|' resources/linux/rpm/code.spec.template
elif [[ "${OS_NAME}" == "windows" ]]; then
  # code.iss
  sed -i 's|https://code.visualstudio.com|https://github.com/HolboxAI/boxcode-ide|' build/win32/code.iss
  sed -i 's|Microsoft Corporation|HolboxAI|' build/win32/code.iss
fi

cd ..
