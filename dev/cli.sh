# Local-dev convenience script for the "insider" channel - NOT called by
# build.sh/CI (that path uses build_cli.sh instead), and boxcode-ide is
# stable-quality-only for now (see product.json / README), so there is no
# real boxcode insider release/update infrastructure to point this at yet.
# Left as VSCodium's own URLs rather than inventing fake boxcode ones that
# would silently 404 - fix for real once an insider channel actually exists.
export CARGO_NET_GIT_FETCH_WITH_CLI="true"
export VSCODE_CLI_APP_NAME="vscodium"
export VSCODE_CLI_BINARY_NAME="codium-server-insiders"
export VSCODE_CLI_DOWNLOAD_URL="https://github.com/VSCodium/vscodium-insiders/releases"
export VSCODE_CLI_QUALITY="insider"
export VSCODE_CLI_UPDATE_URL="https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master"

cargo build --release --target aarch64-apple-darwin --bin=code

cp target/aarch64-apple-darwin/release/code "../../VSCode-darwin-arm64/Boxcode IDE - Insiders.app/Contents/Resources/app/bin/codium-tunnel-insiders"

"../../VSCode-darwin-arm64/Boxcode IDE - Insiders.app/Contents/Resources/app/bin/codium-insiders" serve-web
