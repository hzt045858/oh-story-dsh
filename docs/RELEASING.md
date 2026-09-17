# Release process

`@oh-story/dsh` is distributed as the same prebuilt tarball through npm and
GitHub Releases. A release is created only from a `v<package-version>` tag.

## One-time npm setup

This section applies to the upstream repository `zenstory-ai/oh-story-dsh`,
which owns the `@oh-story/dsh` package name on npm. A fork cannot publish that
name and does not need this setup — see [Releasing from a fork](#releasing-from-a-fork).

The npm account used for the first publication must be allowed to publish the
public `@oh-story/dsh` package. Store a granular publish token as the repository
secret `NPM_TOKEN`; never commit it or put it in an issue, workflow file, or
release note.

After the first publication, configure npm Trusted Publishing for:

- repository: `zenstory-ai/oh-story-dsh`
- workflow: `release.yml`

The workflow requests an OpenID Connect identity and publishes with provenance.
Once Trusted Publishing is verified, the long-lived `NPM_TOKEN` secret can be
removed.

## Cut a release

1. Update the root and package versions, installation examples, and
   `CHANGELOG.md` for the intended release.
2. Run `pnpm verify:release` locally.
3. Commit and push `main`.
4. Create and push the matching `v<package-version>` tag.

The release workflow then:

1. repeats the complete verification suite;
2. builds and inspects a clean installable tarball;
3. checks that the tag and package version match;
4. uploads the tarball and SHA-256 checksum to a GitHub Release;
5. publishes the identical tarball to npm with provenance.

Step 5 only runs in the upstream repository. The GitHub Release and npm steps are
idempotent so a failed workflow can be safely re-run.

## Releasing from a fork

A fork carries its own work on top of upstream, so it needs its own distribution
path. The workflow supports this without any extra configuration:

- steps 1–4 run normally, using the fork's `github.token` for the GitHub Release;
- step 5 is skipped by the `github.repository == 'zenstory-ai/oh-story-dsh'`
  guard, because npm package names are globally unique and a fork can never
  publish `@oh-story/dsh`.

Pushing a `v<package-version>` tag to a fork therefore produces a GitHub Release
whose tarball is the fork's own build — self-built features included. Install
from that asset URL, never from npm, when the goal is the fork's functionality.

The version in `package.json` must still be bumped for every fork release: the
tag/version match check in step 3 fails on a reused version, and GitHub Releases
reject duplicate tag names.

### Windows desktop

`apps/desktop` is fork-only and carries its own version in
`apps/desktop/package.json`, so it releases under its own tag namespace.
Pushing `desktop-v<app-version>` runs the desktop workflow, which repeats the
isolated native tests, builds the portable folder and attaches it to a GitHub
Release:

```bash
git tag desktop-v0.1.8
git push origin desktop-v0.1.8
```

The tag must match `apps/desktop/package.json`. The workflow checks it before
the Rust build starts, so a mismatch costs seconds rather than 40 minutes.

The desktop release is created with `--latest=false`, so the plugin tarball
keeps the `Latest` slot on the Releases page no matter which tag is pushed
first. The zip is still listed under its own tag.

The asset is `Oh-Story-<app-version>-windows-x64.zip`, which unzips to the
`Oh-Story-<app-version>-windows-x64` folder documented under **Run** in
`docs/DESKTOP.md`. The zip keeps that folder layer, so the executable and its
`runtime` directory never land loose in whatever directory the user unzips in.

`v*` stays reserved for the plugin tarball described above. The two prefixes do
not match each other, so neither workflow triggers on the other's tags and the
two never race to create the same release.

Only the portable build is published. The NSIS installer is not, because
shipping an unsigned installer invites users to install it as though it had
been verified. `docs/DESKTOP.md` covers the build, the portable layout and the
runtime patches.

## Verify the public installation

Do not announce a release until the registry reports the exact version:

```bash
VERSION=0.1.9
npm view "@oh-story/dsh@$VERSION" version dist.integrity
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.5-rc.1 dsh plugin --profile web add "@oh-story/dsh@$VERSION"
```

The GitHub Release tarball remains a registry-independent installation path:

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.5-rc.1 dsh plugin --profile web add "https://github.com/zenstory-ai/oh-story-dsh/releases/download/v$VERSION/oh-story-dsh-$VERSION.tgz"
```

For a fork, replace the repository in that URL with the fork's own
`<owner>/<repo>` and skip the npm check above:

```bash
npx -y --package pnpm@11.7.0 --package @deepseek-ai/dsh@0.1.5-rc.1 dsh plugin --profile web add "https://github.com/<owner>/<repo>/releases/download/v$VERSION/oh-story-dsh-$VERSION.tgz"
```

Confirm the release page lists both `oh-story-dsh-$VERSION.tgz` and its
`SHA256SUMS` file before announcing; the checksum is the only integrity signal a
registry-independent install has.
