# Reviewing and merging

How a change gets onto `main` in this repository, and how the relay's image and the browser
extension are released.

## Who reviews

`@princesseke` reviews every pull request. She is listed in `.github/CODEOWNERS` with the owners,
`@gigabytedevelopersinc` and `@enwokoma`, so GitHub asks all three (never the author) when a pull
request is opened. GitHub makes those requests itself, so they show as coming from the pull
request's author; no workflow or token is involved, and nothing appears as `github-actions`.

GitHub never lets authors approve their own pull requests, so her approval is the one the ruleset
counts. A pull request she opens is approved by an owner instead.

A new push dismisses her approval but does not ask her again. Ask her yourself, so the request is
yours too:

```bash
gh pr edit <number> --add-reviewer princesseke
```

## Checks

| Check | Workflow | Required | What it does |
| --- | --- | --- | --- |
| Repository security | `repository-security.yml` | yes | Rejects editor tasks that run when a folder opens, disguised payloads and committed credentials, without running any repository code. |
| Protocol vectors | `protocol-vectors.yml` | not yet | Regenerates the protocol test vectors, which must not change, and recomputes them with the Java crypto APIs Android uses. |
| Protocol package | `protocol-package.yml` | not yet | Builds `packages/protocol` and runs its tests, which reproduce the test vectors. |
| Relay | `relay.yml` | not yet | Builds the relay and runs its API tests. |
| Extension | `extension.yml` | yes | Builds the extension for Chromium and Firefox, runs its strict typecheck and tests, checks each package (permissions, content security policy, inline or remote code), and keeps both zips as an artifact. |
| Extension in browsers | `extension.yml` | yes | Loads each build into the runner's Chrome and Firefox, where its popup must reach its background. |
| Relay image | `relay-image.yml` | not yet | Builds the relay's Docker image, starts it behind Caddy as the self-hosting guide does, pairs and syncs through it, and checks it runs unprivileged and keeps its data across a restart. |

Only required checks block a merge. If you rename a required job, update the matching `context` in
the ruleset as well: a required check that no longer reports leaves pull requests waiting forever.

## Protecting main

`main` is protected by the ruleset **Security: reviewed and signed changes**, and
`.github/rulesets/protect-main.json` is a copy of it. It requires a pull request with one approval
of its latest push, dismisses stale approvals, requires review threads to be resolved and the
required checks to pass on the latest commit, and forbids unsigned commits, force pushes and
deleting `main`. Nobody is on its bypass list, admins included.

After changing the file, apply it to the existing ruleset rather than adding a second one:

```bash
id=$(gh api repos/gigabytedevelopers/CometOTP-Browser/rulesets --jq '.[] | select(.name == "Security: reviewed and signed changes") | .id')
gh api -X PUT "repos/gigabytedevelopers/CometOTP-Browser/rulesets/$id" --input .github/rulesets/protect-main.json
```

## Merging so the commits keep your signature

Do not use the merge button on your own pull requests. GitHub's squash and merge commits are
signed by GitHub, and its rebase merge drops signatures. Merge locally instead, so the commits land
on `main` exactly as you signed them:

```bash
git checkout <branch> && git rebase main     # only if main has moved; this needs a new approval
git checkout main && git merge --ff-only <branch>
git log --format='%h %G? %an %s' origin/main..main   # every new commit: G, signed by you
git push origin main
```

GitHub sees the commits arrive and marks the pull request as merged.

The ruleset accepts this push without any bypass because the commit you push is the head of a pull
request into `main` that is approved and has passed its required checks. Anything else is rejected:
a commit that is not that head, or the head of a pull request that targets another branch. A rebase
that changes the commits gives the pull request a new head, which needs its checks and a fresh
approval before the push goes through.

GitHub counts such a push as a rebase merge, so the ruleset's allowed merge methods must include
**rebase**; with squash alone it answers "merges must occur on the web". Allowing rebase does not
open the web's **Rebase and merge** button: its rewritten commits carry no signature, which the
signed-commits rule refuses.

### Stacked pull requests

A pull request that targets another branch never satisfies `main`'s rule, so a stack cannot be
fast-forwarded onto `main` from the stacked pull request itself. Once the lower pull request has
merged, open a pull request of the upper one's head into `main`, get it approved, and merge that
(gigabytedevelopers/CometOTP-Browser#18 landed #17 this way). Retargeting the upper pull request to
`main` works too, but the base change dismisses its approval. Prefer pull requests that target
`main` directly, merged one after another.

## Releasing the relay image

The relay's image is published to `ghcr.io/gigabytedevelopers/cometotp-relay` by
`relay-release.yml` when a signed tag `relay-vX.Y.Z` is pushed:

1. Merge a pull request that sets the new version in `relay/package.json`, and in the image named in
   `relay/deploy/compose.yaml` and `docs/self-hosting.md`.
2. Tag that commit on `main` with your signature and push the tag:

   ```bash
   git tag -s relay-v0.1.0 -m "Relay 0.1.0"
   git push origin relay-v0.1.0
   ```

The workflow refuses a tag that is not annotated, whose signature GitHub cannot verify, or whose
version is not the one in `relay/package.json`. It then builds the image natively for `amd64` and
`arm64`, pushes each as `X.Y.Z-amd64` and `X.Y.Z-arm64`, and joins them under `X.Y.Z`, `X.Y` and
`latest`.

The first time, the package is private: in its settings on GitHub, change its visibility to public
so that anyone can pull it, and check that it is linked to this repository.

## Releasing the extension

The extension's packages are built by `extension-release.yml` when a signed tag
`extension-vX.Y.Z` is pushed. The workflow publishes nothing: you make the GitHub release from what
it built, so the release shows as yours, and you upload the zips to the stores.

1. Merge a pull request that sets the new version in `extension/package.json` (the manifests take
   it from there).
2. Tag that commit on `main` with your signature and push the tag:

   ```bash
   git tag -s extension-v0.1.0 -m "CometOTP extension 0.1.0"
   git push origin extension-v0.1.0
   ```

   The workflow refuses a tag that is not annotated, whose signature GitHub cannot verify, or whose
   version is not the one in `extension/package.json`. It then builds and tests both packages,
   checks them, loads each into Chrome and Firefox, and keeps as its artifact the two zips, the
   source at the tag (`git archive`) and their `SHA256SUMS`.
3. Once it has passed, download that artifact, check it, and make the release from it:

   ```bash
   v=0.1.0
   run=$(gh run list --workflow extension-release.yml --branch "extension-v$v" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run download "$run" --name "cometotp-extension-$v" --dir "release-$v"
   (cd "release-$v" && shasum -a 256 -c SHA256SUMS)
   gh release create "extension-v$v" --verify-tag --title "CometOTP extension $v" --notes-file <notes> "release-$v"/*
   ```

   The zips are deterministic, so a build of the tag on any machine gives the same bytes.
   Comparing one before releasing shows that CI built exactly the tagged source:

   ```bash
   git checkout "extension-v$v" && npm ci --ignore-scripts
   npm run build --workspace @cometotp/protocol && npm run build --workspace @cometotp/extension
   cmp extension/dist/cometotp-chromium-$v.zip "release-$v/cometotp-chromium-$v.zip"
   cmp extension/dist/cometotp-firefox-$v.zip "release-$v/cometotp-firefox-$v.zip"
   ```

4. Upload the zips to the stores by hand, with the listing in `extension/store/README.md`:
   - **Chrome Web Store:** `cometotp-chromium-X.Y.Z.zip`. The same zip goes to Microsoft Edge
     Add-ons, if listed there.
   - **Firefox Add-ons:** `cometotp-firefox-X.Y.Z.zip`, and the source zip when asked for it, as
     its code was written by a compiler (TypeScript).

## Commit signatures

Every commit carries your own SSH signature and shows GitHub's **Verified** badge. Check before
pushing that every new commit shows `G` and your name, as above. If the signing key is unavailable,
leave the work uncommitted: never push an unsigned commit or rely on GitHub's web-flow signature.
