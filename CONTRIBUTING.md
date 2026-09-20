# Contributing

## Commit conventions

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
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

## PR checklist

- [ ] Linked issue in the PR description
- [ ] Conventional commit messages with GPG sign and DCO sign-off
- [ ] CI: security scan, markdown lint passing
- [ ] No secrets or credentials introduced
- [ ] Documentation updated where needed
