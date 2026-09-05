# Builds and releases

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatch. Each job uses Bun 1.4.0, installs the frozen lockfile, runs `bun run check`, and builds and smoke-tests a standalone executable on its native architecture.

| Target      | GitHub runner      |
| ----------- | ------------------ |
| macOS arm64 | `macos-15`         |
| macOS x64   | `macos-15-intel`   |
| Linux x64   | `ubuntu-24.04`     |
| Linux arm64 | `ubuntu-24.04-arm` |

Successful jobs upload `cmdz-<platform>-<arch>` artifacts containing a `.tar.gz` and its SHA-256 checksum. Archives preserve the executable bit. Downloads expire after seven days. They are CI test builds, not supported releases. Linux artifacts target the runner's glibc environment; musl and older Linux distributions are not yet verified.

The workflow has read-only repository permissions and no signing credentials. Actions are pinned to commit SHAs. It never publishes a release or package.

After the repository is created under `planetaryescape` and this branch is pushed, enable Actions if required by organisation policy, then run CI manually or push to `main`. Check all four jobs before treating any new target as verified. Private repositories consume the organisation's Actions allowance; public repositories have free standard hosted runners.

## macOS signing

Signing identifies the publisher and detects changes to a binary. Notarization is Apple's automated malware scan of signed distribution artifacts, not App Store review.

The currently tested macOS binary has an ad-hoc linker signature and no Developer ID identity. That is enough for local execution, but is not a trusted publisher signature and does not establish Gatekeeper approval for downloaded files.

Before broad macOS distribution, choose one of:

- Ad-hoc builds for early testers, with potential Gatekeeper friction clearly disclosed.
- Developer ID Application signing through an Apple Developer Program team.
- Developer ID signing plus notarization, the recommended public-distribution route outside the App Store.

Signing Bun executables also requires checking the hardened-runtime entitlements needed for its JavaScript runtime. Keep credentials in restricted CI secrets and signing in a trusted release job, never in pull-request jobs. Signing, notarization, and downloaded-file Gatekeeper verification remain unimplemented.

## Before a public release

- Confirm repository name and visibility.
- Verify all native CI jobs.
- Choose the project license and include required third-party notices.
- Add a version and CLI `--help` / `--version` handling.
- Decide macOS signing and notarization.
- Add a tag-triggered draft release workflow with approved, versioned artifacts.

References: [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
