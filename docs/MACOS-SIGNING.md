# macOS signing and distribution

Covexcode IDE ships through two different macOS channels. They use different
Apple certificate types and must not be mixed.

| Channel | Certificate | Provisioning profile | Distribution |
| --- | --- | --- | --- |
| Direct `.dmg` / `.zip` | Developer ID Application | None | Notarized by Apple, downloaded from GitHub Releases |
| Mac App Store (future) | Apple Distribution | Mac App Store profile for `com.covexcode.Covexcode` | App Store / TestFlight |

Apple Developer team: **SPRINGTOWNAI LLC** (`MSC8P8G9J4`).

The existing **Developer ID Application** identity is:

```
Developer ID Application: SPRINGTOWNAI LLC (MSC8P8G9J4)
```

Direct-distribution builds are signed and notarized when the five
`CERTIFICATE_OSX_*` Actions secrets are present. The current `1.126.0.362`
build predates those secrets, so it is ad-hoc signed and Gatekeeper warns.

---

## 1. Direct downloads (now)

### Required repository secrets

Add these to **HolboxAI/covexcode-ide → Settings → Secrets and variables →
Actions**. Use the same values already used by `HolboxAI/boxcode-ide`:

| Secret | Value |
| --- | --- |
| `CERTIFICATE_OSX_P12_DATA` | Base64 of the Developer ID `.p12` (certificate + private key) |
| `CERTIFICATE_OSX_P12_PASSWORD` | Password for that `.p12` |
| `CERTIFICATE_OSX_APPLE_ID` | Apple ID used for notarization |
| `CERTIFICATE_OSX_TEAM_ID` | `MSC8P8G9J4` |
| `CERTIFICATE_OSX_APP_PASSWORD` | Apple app-specific password for `notarytool` |

GitHub does not expose secret values after they are saved — the API and UI are
write-only. Copying from `boxcode-ide` therefore means one of:

- **Organization secrets:** if the five secrets live at the organization level,
  add `covexcode-ide` to each secret's repository access list. No value copying
  is needed.
- **Repository secrets:** re-enter the same values in `covexcode-ide`. The
  certificate and team ID are recoverable; the Apple ID and app-specific
  password must come from the account holder's records.

### Exporting the certificate

The Developer ID certificate and private key are in the login keychain. A local
backup exists at `~/Documents/Certificates.p12`.

To create a fresh `.p12` with a new password:

1. Open **Keychain Access → login → My Certificates**.
2. Select `Developer ID Application: SPRINGTOWNAI LLC (MSC8P8G9J4)` with its
   private key.
3. Right-click → **Export** → `.p12`, set a password.
4. Base64-encode and set the secrets:

```bash
base64 -i /path/DeveloperID.p12 > /tmp/DeveloperID.p12.b64

gh secret set CERTIFICATE_OSX_P12_DATA \
  --repo HolboxAI/covexcode-ide < /tmp/DeveloperID.p12.b64

gh secret set CERTIFICATE_OSX_P12_PASSWORD \
  --repo HolboxAI/covexcode-ide        # prompt for the .p12 password

gh secret set CERTIFICATE_OSX_APPLE_ID \
  --repo HolboxAI/covexcode-ide        # prompt for the Apple ID

gh secret set CERTIFICATE_OSX_TEAM_ID \
  --repo HolboxAI/covexcode-ide --body MSC8P8G9J4

gh secret set CERTIFICATE_OSX_APP_PASSWORD \
  --repo HolboxAI/covexcode-ide        # prompt for the app-specific password

rm /tmp/DeveloperID.p12.b64
```

The app-specific password is generated at
[appleid.apple.com](https://appleid.apple.com) → Sign-In and Security →
App-Specific Passwords. The same password can be reused for both Boxcode and
Covexcode.

### Build and verify

Push a commit or tag to trigger `CI - Build - macOS`. `prepare_assets.sh`
imports the certificate into a temporary keychain, signs with
`@electron/osx-sign` (hardened runtime, per-helper entitlements), submits the
zip to `notarytool`, and staples the ticket.

Verify the published app:

```bash
codesign --verify --deep --strict --verbose=2 "Covexcode IDE.app"
spctl -a -vv "Covexcode IDE.app"          # should say accepted
xcrun stapler validate "Covexcode IDE.app"  # should say the ticket is valid
```

Release notes should say **“Developer ID–signed and notarized”** rather than
“Unsigned (ad-hoc)”.

---

## 2. Mac App Store (future)

The App Store uses a different certificate and a provisioning profile.

### What to create in the Apple Developer portal

1. **Apple Distribution certificate**
   - Certificates → **+** → **Apple Distribution**.
   - This is the certificate type for Mac App Store distribution; it is not the
     same as Developer ID Application.
2. **Explicit App ID**
   - Identifiers → App IDs → **+** → macOS.
   - Bundle ID: **`com.covexcode.Covexcode`**.
3. **Mac App Store provisioning profile**
   - Profiles → **+** → Distribution → **Mac App Store**.
   - Select the `com.covexcode.Covexcode` App ID and the Apple Distribution
     certificate.
   - Download the `.mobileprovision`.
4. **App Store Connect app record**
   - Create a macOS app with the same bundle ID, SKU, and company details.

### Future CI secrets for the App Store channel

Keep these separate from the Developer ID secrets:

- `MAC_APP_STORE_P12_DATA`
- `MAC_APP_STORE_P12_PASSWORD`
- `MAC_APP_STORE_PROVISIONING_PROFILE`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_PRIVATE_KEY`
- `APPLE_TEAM_ID` = `MSC8P8G9J4`

The App Store build needs its own signing path: embed the Mac App Store
provisioning profile, sign with the Apple Distribution certificate, and use
App Store Connect / Transporter rather than `notarytool`.

### App Store readiness requirements

Do not switch the direct-download build to the App Store path. A VS Code /
Electron app with a coding agent has additional constraints:

- **App Sandbox** entitlements are mandatory. The current build runs an
  extension host, a terminal, an integrated browser, and the `covexcode` CLI.
  Those need sandbox-compatible behavior and file paths.
- **No self-update.** Disable the Covexcode update feed in the App Store build
  and rely on App Store updates.
- **No downloading/executing arbitrary code** without review. The extension
  marketplace, integrated terminal, and agent shell commands may need to be
  restricted in an App Store edition.
- **CLI packaging.** Either sign and bundle a sandbox-compatible CLI, or keep
  the CLI as a separate download and adjust the IDE onboarding.
- **Review guidelines.** Expect App Review scrutiny of a terminal/agent that can
  execute commands on the user's machine.

Treat the Mac App Store build as a separate product configuration, not a
different signing flag on the existing release.

### Provisioning profile note

`Covexcode_Ide.provisionprofile` is for App ID **`com.covexcode`**, not the
IDE's **`com.covexcode.Covexcode`**. It is not used by the Developer ID flow
(`sign-app.mjs` sets `preEmbedProvisioningProfile: false`). For the App Store,
create a new Mac App Store profile for `com.covexcode.Covexcode`.

---

## Checklist

### Direct downloads

- [ ] Add the five `CERTIFICATE_OSX_*` secrets to `HolboxAI/covexcode-ide`
- [ ] Trigger a fresh macOS build
- [ ] Confirm release notes say signed and notarized
- [ ] `spctl -a -vv` accepts the app
- [ ] `xcrun stapler validate` succeeds

### Mac App Store

- [ ] Create Apple Distribution certificate
- [ ] Create explicit App ID `com.covexcode.Covexcode`
- [ ] Create Mac App Store provisioning profile
- [ ] Create App Store Connect app record
- [ ] Build a sandboxed App Store configuration
- [ ] Disable self-update in that configuration
- [ ] Review terminal / agent / marketplace behavior for App Review
- [ ] Upload with Transporter or `xcrun altool --upload-app`
