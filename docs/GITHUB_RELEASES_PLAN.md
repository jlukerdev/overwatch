# GitHub repo move and automated Releases: plan

Notes for moving OverWatch (View Protect) to its own public GitHub repo and building Releases with GitHub Actions. Nothing here is done yet. Written 2026-11-19.

## What the repo already provides

- **Build:** `npm run dist` fetches go2rtc for all targets (SHA-256 verified against `scripts/go2rtc.manifest.json`), builds, and runs electron-builder.
  - macOS: `OverWatch-<version>-arm64.dmg` and `OverWatch-<version>-x64.dmg` (Intel)
  - Windows: `OverWatch-<version>-x64.exe` (NSIS)
  - None are signed with a certificate. The macOS apps are ad-hoc signed.
- **Checks:** `npm run lint`, `npm run format:check`, `npm run typecheck` (run inside `npm run build`), `npm test` (Vitest).
- **Node:** 24, from `.nvmrc`. The scripts run `.ts` files directly, so the Node version matters.
- **Version:** `package.json` is `1.0.1`. electron-builder takes the installer version from it.
- **README:** already tells users to download from the releases and explains the Gatekeeper/SmartScreen first-launch steps.

## 1. Before the move

1. **Make the project the repo root.** Workflows must live at `.github/workflows/` in the new repo. Use `git subtree split` or `git filter-repo --subdirectory-filter HomeAutomation/Security/view-protect` to keep history, or start fresh.
2. **Audit history before going public.** Scan with `gitleaks` or `trufflehog` for secrets and local network details (IPs, tokens, console names). A grep of the current tree only hit docs and the lockfile, but old commits could differ.
3. **Check what is being redistributed.**
   - `docs/reference/` contains Ubiquiti's Access API PDF and the Protect OpenAPI JSON. Confirm publishing them is allowed, or remove them and link instead.
   - Add a `LICENSE` (none exists outside `src/renderer/src/player/vendor/`).
4. **Update `CLAUDE.md`.** It says PRs go into `feature/view-protect`, never `main`. Choose a new branch model. Refresh paths and the "View Protect" naming where needed.
5. **Check example env files** (`.env.example`) carry no real values.

## 2. Workflows to add

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

## 3. Public docs hosting (GitHub Pages)

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

## 4. Decision: how versions work

A Release needs a unique tag, so "a Release on every commit" needs a versioning scheme.

| Option | How it works | Trade-off |
|---|---|---|
| Auto-version | Tag `v1.0.<run_number>` or `v1.0.0-<shortsha>`. Pass `-c.extraMetadata.version=<ver>` to electron-builder so filenames and the in-app version match. Mark as prerelease. | Matches "release on every commit". Many releases. |
| Tag-driven | Build and release only on a pushed `v*` tag. CI still runs on every push. | Cleanest, usual approach. Bump `package.json` and tag by hand. |
| release-please / semantic-release | Version and changelog from conventional commits. | Most setup. Needs a commit convention. |

**Leaning:** CI on every commit, auto-built prereleases on `main`, and a tag-driven stable release. Not decided yet.

## 5. Things to know

- **Unsigned builds:** `electron-builder.yml` notes this. Signing is optional later. It needs an Apple Developer account (about $99/yr) with a cert and notarization secrets, and a Windows signing cert. None are needed now.
- **Secrets:** unsigned builds need only the built-in `GITHUB_TOKEN`.
- **go2rtc fetch:** downloads from GitHub Releases and is hash-verified, so it is safe on CI. Caching `resources/bin` is optional.
- **Repo settings:**
  - Enable Actions.
  - Set "Workflow permissions" so the release job can write.
  - If `main` is protected, the release job must not need to push a version-bump commit. Tags and Releases do not count as pushes to the branch.
- **e2e:** `tests/e2e/smoke.spec.ts` is not in any npm script. On Linux CI it would need a display (`xvfb`). Leave it out at first.

## 6. Checklist

- [ ] Scan history for secrets and local details
- [ ] Decide on Ubiquiti reference docs (keep, remove, or link)
- [ ] Add `LICENSE`
- [ ] Split or move the project into the new repo root
- [ ] Update `CLAUDE.md` branch model and paths
- [ ] Choose a versioning approach (section 4)
- [ ] Add `ci.yml`
- [ ] Add `release.yml`
- [ ] Add `dependabot.yml`
- [ ] Enable GitHub Pages (source: GitHub Actions)
- [ ] Add `pages.yml` publishing only the guide, brochure and `guide-img/`
- [ ] Review guide screenshots for private details
- [ ] Update `README.md` with the public guide and brochure URLs
- [ ] Verify both public pages and all images load
- [ ] Enable Actions and set workflow permissions in repo settings
- [ ] Run a test release and install both builds
- [ ] Confirm the README download instructions match the Release asset names
