# Developer Setup

This guide covers the local tooling and authentication setup required to contribute to repos under `clouatre-labs`.

## Prerequisites

- [git](https://git-scm.com/) (2.40+)
- [gh](https://cli.github.com/) (GitHub CLI)
- [GPG](https://gnupg.org/) (2.4+)
- SSH key pair (ed25519)

## Git Identity

Set your name, email, and GPG signing key globally or per-repo:

```bash
git config --global user.name "Your Name"
git config --global user.email "your@email.com"
git config --global commit.gpgsign true
git config --global user.signingkey $(gpg --list-secret-keys --keyid-format LONG | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
```

Verify:

```bash
git config --global --list | grep user
```

## SSH Key

Generate a single ed25519 key if you do not have one:

```bash
ssh-keygen -t ed25519 -C "your@email.com"
```

Add the public key to your GitHub account under **Settings > SSH and GPG keys > New SSH key**.

Verify the connection:

```bash
ssh -T git@github.com
```

## GitHub CLI Authentication

Authenticate `gh` with your GitHub account:

```bash
gh auth login
```

Choose the HTTPS protocol (or SSH), and follow the browser-based OAuth flow.

Verify:

```bash
gh auth status
```

## GPG Key

Generate a signing key if you do not have one:

```bash
gpg --full-generate-key
```

Use the default RSA (4096-bit) or ed25519 option. Use the email address associated with your GitHub account.

List your keys and export the public key:

```bash
gpg --list-secret-keys --keyid-format LONG
gpg --armor --export <KEY-ID>
```

Add the exported public key under **GitHub Settings > SSH and GPG keys > New GPG key**.

## Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>: <description>

[optional body]

Signed-off-by: Your Name <your@email.com>
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `ci`, `test`, `style`, `perf`, `security`.

Every commit must include a DCO sign-off trailer (`--signoff`). The CI pipeline enforces both conventional commit format and the sign-off.

## Verification

Run these checks to confirm your setup is complete:

```bash
git config --global --list | grep -E "user\.(name|email|signingkey)"
gpg --list-secret-keys --keyid-format LONG
ssh -T git@github.com
gh auth status
```

## Quick Start

```bash
# Clone a repo
git clone git@github.com:clouatre-labs/<repo>.git
cd <repo>

# Make a change and commit
git commit -S --signoff -m "feat: add new feature"
git push
```