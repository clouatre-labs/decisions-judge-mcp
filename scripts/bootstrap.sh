#!/usr/bin/env bash
# bootstrap.sh - Idempotent repo setup for repos created from clouatre-labs/template-repo.
# Run from within the cloned repo: bash scripts/bootstrap.sh
# Requires: gh CLI authenticated with repo write access.

set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
  echo "ERROR: could not detect repo. Run this script from within the cloned repository."
  exit 1
fi

echo "Creating labels for ${REPO} ..."

gh label create "bug"            --color "d73a4a" --description "Defect or unexpected behavior"                     --repo "$REPO" --force
gh label create "documentation"  --color "0075ca" --description "Documentation improvements"                        --repo "$REPO" --force
gh label create "duplicate"      --color "cfd3d7" --description "Duplicate issue or PR"                             --repo "$REPO" --force
gh label create "enhancement"    --color "a2eeef" --description "New feature or improvement"                        --repo "$REPO" --force
gh label create "good first issue" --color "7057ff" --description "Good for newcomers"                              --repo "$REPO" --force
gh label create "help wanted"    --color "008672" --description "Extra attention needed"                            --repo "$REPO" --force
gh label create "invalid"        --color "e4e669" --description "Not valid or out of scope"                         --repo "$REPO" --force
gh label create "question"       --color "d876e3" --description "Question or discussion"                            --repo "$REPO" --force
gh label create "wontfix"        --color "ffffff" --description "Will not be addressed"                             --repo "$REPO" --force
gh label create "refactor"       --color "0075ca" --description "Code cleanup with no behavior change"              --repo "$REPO" --force
gh label create "chore"          --color "d4c5f9" --description "Maintenance and tooling"                           --repo "$REPO" --force
gh label create "ci"             --color "e6e6e6" --description "CI pipeline changes"                               --repo "$REPO" --force
gh label create "dependencies"   --color "0366d6" --description "Dependency updates"                                --repo "$REPO" --force
gh label create "security"       --color "b60205" --description "Security fixes and hardening"                      --repo "$REPO" --force
gh label create "github_actions" --color "000000" --description "Pull requests that update GitHub Actions code"    --repo "$REPO" --force

echo "Labels created (or updated if they already existed)."
echo ""
echo "Next step: create the branch ruleset."
echo "Run the following command (requires repo admin access):"
echo ""
cat <<EOF
gh api repos/$REPO/rulesets -X POST \
  --input - <<'RULESET'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "pull_request"
    }
  ],
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_signatures"},
    {
      "type": "commit_message_pattern",
      "parameters": {
        "name": "DCO Sign-off",
        "operator": "contains",
        "pattern": "Signed-off-by:",
        "negate": false
      }
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": false,
        "require_last_push_approval": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          {"context": "CI Result", "integration_id": null},
          {"context": "Security Result", "integration_id": null},
          {"context": "Lint markdown", "integration_id": null}
        ]
      }
    }
  ]
}
RULESET
EOF