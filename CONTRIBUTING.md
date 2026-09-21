# Contributing

## Local setup

- Tools: git, [gh](https://cli.github.com/), GPG (commit signing), SSH with a key registered on GitHub.
- Authenticate: `gh auth login`; verify with `ssh -T git@github.com && gh auth status`.

## Commit conventions

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <short description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `ci`, `chore`, `test`.

Every commit must be GPG-signed and include a DCO sign-off:

```bash
git commit -S --signoff -m "feat(scope): description"
```

The DCO certifies that you have the right to contribute the change under the project licence.
By signing off you agree to the [Developer Certificate of Origin](https://developercertificate.org/).

## Branch model

- `main` is the protected trunk; no direct commits.
- Open a feature branch from the latest `origin/main`:

```bash
git fetch -p
git checkout -b feat/short-description origin/main
```

- One logical change per branch. Keep PRs focused and atomic.

## Pull request flow

1. Push your branch and open a PR against `main`.
2. Fill in the PR template fully.
3. Ensure all CI checks pass before requesting review.
4. Address review comments by amending commits or adding fix commits; do not force-push after review has started.
5. A maintainer will squash-merge after approval.

## Merge Strategy and Cleanup

This repository enforces a **squash-merge only** policy:

- Merge commits are disabled; only squash merges are allowed
- Rebase merges are also disabled
- After merge, the source branch is deleted automatically

Squash merges produce a linear, readable commit history; each PR becomes one logically-complete commit on `main`. This keeps the history clean and makes it easier to revert changes or bisect for regressions if needed.

Automatic branch deletion removes the source branch immediately after merge, eliminating stale branches and keeping the branch list manageable. If you need to retain a feature branch for reference, create a tag pointing to the branch's tip commit before merging.

## Release process

Releases follow the tagged-release workflow used across clouatre-labs repos:

1. Merge the release PR (`chore(release): vX.Y.Z`) with all checks green.
2. Create a signed, annotated tag pointing at the `main` HEAD commit and push it:

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z" origin/main
   git push origin vX.Y.Z
   ```

3. The `publish` workflow then runs automatically:
   - Verifies the tag is signed, annotated, and points at `main` HEAD.
   - Creates a GitHub Release with automatically generated notes.
   - Publishes the package to npm with provenance (OIDC trusted publishing).

Note on tag creation: the organization's "Release Tag Protection" ruleset
restricts creation of `v*.*.*` tags, but grants organization admins and the
write role an `always` bypass. Pushing a release tag therefore records a
"Bypassed rule violations" event in the audit log — this is expected and is the
audit trail for the release. The workflow's signature and main-HEAD checks are
the enforced gates.

## PR checklist

- [ ] Linked issue in the PR description
- [ ] Conventional commit messages with GPG sign and DCO sign-off
- [ ] CI: security scan, markdown lint passing
- [ ] No secrets or credentials introduced
- [ ] Documentation updated where needed
