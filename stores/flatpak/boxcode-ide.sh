#!/bin/sh
# Electron in a Flatpak cannot use the setuid chrome-sandbox from the .deb.
# The .desktop Exec in the deb points at the electron binary
# (/usr/share/boxcode-ide/boxcode-ide), not the CLI wrapper, so launch that
# and pass --no-sandbox the same way the Snap does.
#
# install.sh puts the CLI in ~/.local/bin, which is not on Flatpak's PATH.
# /usr/local/bin on the host is not this sandbox's /usr/local/bin.

HOME_BIN="${HOME}/.local/bin:${HOME}/.boxcode/bin:${HOME}/.cargo/bin"
export PATH="${HOME_BIN}:${PATH}"

ELECTRON="/app/share/boxcode-ide/boxcode-ide"
if [ ! -x "${ELECTRON}" ]; then
  echo "boxcode-ide is missing from the Flatpak: ${ELECTRON}" >&2
  exit 127
fi

if command -v zypak-wrapper >/dev/null 2>&1; then
  exec zypak-wrapper "${ELECTRON}" "$@"
fi

exec "${ELECTRON}" --no-sandbox "$@"
