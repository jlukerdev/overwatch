# GitHub repo move and automated Releases: plan

Notes for moving OverWatch (View Protect) to its own public GitHub repo and building Releases with GitHub Actions. The move to the new repo is done. Written 2026-11-19. On 2026-11-21 the workflows were added on branch `view-protect/github-releases` (see `docs/DEVELOPMENT.md`, "CI, Releases and Pages"), Pages was set to build from GitHub Actions, and Actions were confirmed enabled. The workflows first run once that PR is merged; the checklist in section 5 shows what is left.

## What the repo already provides

- **Build:** `npm run dist` fetches go2rtc for all targets (SHA-256 verified against `scripts/go2rtc.manifest.json`), builds, and runs electron-builder.
  - macOS: `OverWatch-<version>-arm64.dmg` and `OverWatch-<version>-x64.dmg` (Intel)
  - Windows: `OverWatch-<version>-x64.exe` (NSIS)
  - None are signed with a certificate. The macOS apps are ad-hoc signed.
- **Checks:** `npm run lint`, `npm run format:check`, `npm run typecheck` (run inside `npm run build`), `npm test` (Vitest).
- **Node:** 24, from `.nvmrc`. The scripts run `.ts` files directly, so the Node version matters.
- **Version:** `package.json` is `1.0.1`. electron-builder takes the installer version from it.
- **README:** already tells users to download from the releases and explains the Gatekeeper/SmartScreen first-launch steps.

## 1. Workflows to add

### `.github/workflows/ci.yml` (pull requests and pushes)

- Ubuntu runner.
- Steps: `actions/setup-node` with `node-version-file: .nvmrc` and npm cache, then `npm ci`, `npm run lint`, `npm run format:check`, `npm run build` (includes typecheck), `npm test`.
- `npm ci` runs `postinstall: install-electron`, which needs network. That is fine on runners.

### `.github/workflows/release.yml` (pushes to `main`, and/or `v*` tags)

- One `macos-latest` (arm64) job can build all three installers with `npm run dist:all` (the NSIS toolset runs natively there). Or use a matrix of `macos-latest` (`dist:mac`) and `windows-latest` (`dist:win`).
- Each job: `npm ci`, then `npm run dist -- --mac` or `npm run dist -- --win`, with `--publish never`. `predist` fetches go2rtc.
- Upload installers as artifacts.
- A final Ubuntu job with `permissions: contents: write` creates the Release (`gh release create` or `softprops/action-gh-release`) and attaches both installers.
- The `afterPack` go2rtc check runs on either layout, so a wrong or stale binary fails the job.

### `.github/dependabot.yml`

- Ecosystems: `npm` and `github-actions`. Pin Actions by major version or SHA.

## 2. Public docs hosting (GitHub Pages)

**Requirement:** the user guide and the brochure must be publicly reachable from GitHub, and `README.md` must link to them by their public URLs.

Current state:
- `docs/guide.html` (16 KB) and `docs/brochure.html` (36 KB) are standalone pages.
- `docs/guide-img/` holds the 10 guide screenshots (about 3 MB). The guide references them by relative path (`guide-img/*.png`), so they must be published next to the guide.
- Both pages load fonts from Google Fonts. That is fine on a public site.
- `README.md` line 49 currently says "A full getting-started guide is coming."

Plan:
1. **Enable GitHub Pages** with source "GitHub Actions" (repo Settings, Pages). Raw `.html` in the repo is shown as source on github.com, so Pages is needed to render it.
2. **Add `.github/workflows/pages.yml`**, triggered on pushes to `main` that touch `docs/guide.html`, `docs/brochure.html` or `docs/guide-img/**` (plus `workflow_dispatch`).
   - Stage a `site/` folder containing only the public pages and images, not the whole `docs/` folder (SPEC, DEV_PLAN, the Ubiquiti references and spikes should not be published).
   - Run `actions/configure-pages`, `actions/upload-pages-artifact` and `actions/deploy-pages`. Permissions: `pages: write`, `id-token: write`.
3. **Pick the URL layout.** Either serve at `https://<user>.github.io/<repo>/guide.html` and `/brochure.html`, or stage them as `guide/index.html` and `brochure/index.html` for cleaner URLs (then fix the `guide-img/` paths, or keep the images alongside). Add an `index.html` that links to both, or redirects to the brochure.
4. **Update `README.md`:** replace the "guide is coming" line with the public guide URL and add the brochure URL. Do this after the repo name is final, since the URLs contain it.
5. **Keep the page contents public-safe.** Check the screenshots in `guide-img/` for real camera names, locations, IPs or faces before publishing.
6. **Optional:** link the guide and brochure from the Release notes, the repo "About" website field, and the app's Help or About text if it has one.
7. **Verify** after the first deploy: both URLs load, all 10 images render, and the README links work.

## 3. Decision: how versions work

A Release needs a unique tag, so "a Release on every commit" needs a versioning scheme.

| Option | How it works | Trade-off |
|---|---|---|
| Auto-version | Tag `v1.0.<run_number>` or `v1.0.0-<shortsha>`. Pass `-c.extraMetadata.version=<ver>` to electron-builder so filenames and the in-app version match. Mark as prerelease. | Matches "release on every commit". Many releases. |
| Tag-driven | Build and release only on a pushed `v*` tag. CI still runs on every push. | Cleanest, usual approach. Bump `package.json` and tag by hand. |
| release-please / semantic-release | Version and changelog from conventional commits. | Most setup. Needs a commit convention. |

**Decided (2026-11-21):** CI on every commit, an auto-built prerelease `v<pkg>-main.<run number>` on every push to `main` (the next patch once `v<pkg>` is released), and a stable release from a pushed `v<pkg>` tag. Built on one `macos-latest` runner with `dist:all`. Pages URLs: `/guide.html` and `/brochure.html`, with the root redirecting to the brochure.

## 4. Things to know

- **Unsigned builds:** `electron-builder.yml` notes this. Signing is optional later. It needs an Apple Developer account (about $99/yr) with a cert and notarization secrets, and a Windows signing cert. None are needed now.
- **Secrets:** unsigned builds need only the built-in `GITHUB_TOKEN`.
- **go2rtc fetch:** downloads from GitHub Releases and is hash-verified, so it is safe on CI. Caching `resources/bin` is optional.
- **Repo settings:**
  - Enable Actions.
  - Set "Workflow permissions" so the release job can write.
  - If `main` is protected, the release job must not need to push a version-bump commit. Tags and Releases do not count as pushes to the branch.
- **e2e:** `tests/e2e/smoke.spec.ts` is not in any npm script. On Linux CI it would need a display (`xvfb`). Leave it out at first.

## 5. Checklist

- [x] Choose a versioning approach (section 3)
- [x] Add `ci.yml`
- [x] Add `release.yml`
- [x] Add `dependabot.yml`
- [x] Enable GitHub Pages (source: GitHub Actions)
- [x] Add `pages.yml` publishing only the guide, brochure and `guide-img/`
- [x] Review guide screenshots for private details (they were already public in the README)
- [x] Update `README.md` with the public guide and brochure URLs
- [ ] Verify both public pages and all images load
- [x] Enable Actions and set workflow permissions in repo settings (default stays read-only; each job asks for what it needs)
- [ ] Run a test release and install both builds
- [x] Confirm the README download instructions match the Release asset names
