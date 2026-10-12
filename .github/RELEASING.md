# Reviewing and merging

How a change gets onto `main` in this repository. Nothing is released yet: the relay image and the
extension add their release steps here when they exist.

## Who reviews

`@princesseke` reviews every pull request. The **Request review** workflow asks her when a pull
request is opened or marked ready, and again on every push, since a push dismisses her earlier
approval. It runs from the copy on `main`, so until it has been merged, ask her by hand:

```bash
gh pr edit <number> --add-reviewer princesseke
```

The owners in `.github/CODEOWNERS` are asked too, but GitHub never lets authors approve their own
pull requests, so her approval is the one the ruleset counts. A pull request she opens is approved
by an owner instead.

## Required checks

| Check | Workflow | What it does |
| --- | --- | --- |
| Repository security | `repository-security.yml` | Rejects editor tasks that run when a folder opens, disguised payloads and committed credentials, without running any repository code. |
| Protocol vectors | `protocol-vectors.yml` | Regenerates the protocol test vectors, which must not change, and recomputes them with the Java crypto APIs Android uses. |

If you rename a job, update the matching `context` in the ruleset as well. A required check that
no longer reports leaves pull requests waiting for it forever.

## Protecting main

`.github/rulesets/protect-main.json` is the branch ruleset. Import it once:

```bash
gh api -X POST repos/gigabytedevelopers/CometOTP-Browser/rulesets --input .github/rulesets/protect-main.json
```

After changing the file, update the existing ruleset instead of adding a second one:

```bash
gh api -X PUT repos/gigabytedevelopers/CometOTP-Browser/rulesets/<id> --input .github/rulesets/protect-main.json
```

It requires a pull request with one approval of its latest push, dismisses stale approvals,
requires review threads to be resolved and the checks above to pass on the latest commit, and
forbids unsigned commits, merge commits, force pushes and deleting `main`.

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

That push goes straight to `main`, so it only works for someone the ruleset lets bypass it; the
repository **admin** role is on the bypass list for this reason. Keep that role for the few people
who merge. Without any bypass, the only way onto `main` is GitHub's squash merge, which GitHub
signs instead of you.

### Stacked pull requests

When one pull request builds on another, it targets the branch below it rather than `main`. Do not
retarget it to `main` later: a base change dismisses its approval. Merge the stack from the bottom,
each with a fast-forward as above. Because a stacked pull request's base is the branch below, GitHub
only marks it merged once its commits reach that branch, so push them there too:

```bash
git push origin <stacked-branch>:<branch-below>
```

## Commit signatures

Every commit carries your own SSH signature and shows GitHub's **Verified** badge. Check before
pushing that every new commit shows `G` and your name, as above. If the signing key is unavailable,
leave the work uncommitted: never push an unsigned commit or rely on GitHub's web-flow signature.
