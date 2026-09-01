# Code Signing Policy

## Overview

This document describes how MineDesk's Windows binaries are built and signed, so anyone who downloads them can verify the software they're running genuinely comes from this project's source code and hasn't been tampered with in transit.

**Status**: MineDesk is applying for a free release-signing certificate through [SignPath Foundation](https://signpath.org). This policy describes the intended process; the certificate details below will be filled in once a release certificate is issued.

## Certificate Information

| | |
|---|---|
| Publisher | SignPath Foundation (pending approval) |
| Signature algorithm | SHA-256 |
| Timestamp server | SignPath-managed |
| Certificate type | OV code signing |

## How to Verify

Once signed builds are available:

1. Right-click `MineDesk_<version>_x64-setup.exe` → **Properties** → **Digital Signatures** tab
2. Confirm the signer is **SignPath Foundation** and the signature is valid

Or via PowerShell:

```powershell
Get-AuthenticodeSignature .\MineDesk_<version>_x64-setup.exe | Format-List
```

## Why SignPath Foundation?

MineDesk is a free, open-source project with no revenue to fund a commercial EV code-signing certificate (typically $300–600/year). SignPath Foundation sponsors free, CA-trusted signing for qualifying open-source projects, which removes the "unknown publisher" warnings (Windows SmartScreen / Smart App Control) that otherwise block an unsigned installer on end-user machines.

## Build Verification

Every release is built from source on a clean, disposable GitHub-hosted runner — never from a maintainer's own machine — via [`.github/workflows/build-desktop.yml`](.github/workflows/build-desktop.yml):

1. Checkout the tagged commit from [github.com/RiteshKumar2e/MineDesk](https://github.com/RiteshKumar2e/MineDesk)
2. Build the Windows Remote Agent (`backend/agent`, Rust) in release mode
3. Build the desktop app shell (`frontend/src-tauri`, Tauri) with the agent bundled as a sidecar
4. Produce the NSIS/MSI installers as build artifacts

Only artifacts produced by this workflow are submitted for signing — nothing built locally is ever signed.

## Team Roles

| Role | Person | Responsibility |
|---|---|---|
| Author | Ritesh Kumar ([@RiteshKumar2e](https://github.com/RiteshKumar2e)) | Writes and merges code |
| Approver | Ritesh Kumar ([@RiteshKumar2e](https://github.com/RiteshKumar2e)) | Reviews and authorizes each signing request |

MineDesk is currently a single-maintainer project; author and approver are the same person until the team grows.

## Security Practices

- Private signing keys are held in SignPath's HSM and never exposed to this project or its CI
- Each signing request requires manual approval and is tied to a specific GitHub Actions run (origin verification) — an artifact built anywhere else cannot be signed
- Signatures are timestamped, so they remain valid even after the certificate itself expires
- Release binaries are never modified after signing

## Reporting a Suspicious Binary

If you downloaded a MineDesk installer that seems tampered with, doesn't match a signature above, or behaves unexpectedly:

1. **Do not run it.**
2. Open an issue at [github.com/RiteshKumar2e/MineDesk/issues](https://github.com/RiteshKumar2e/MineDesk/issues) with the file's SHA-256 hash (`Get-FileHash <file>` in PowerShell) and where you downloaded it from
3. If it appears actively malicious, also report it to SignPath at security@signpath.io

## Other Platforms

| Platform | Status |
|---|---|
| Windows | Signed installer (pending SignPath approval) |
| macOS | Not built |
| Linux | Not built |
