#!/bin/bash
# scripts/build_images.sh
#
# Trigger Docker image builds for a custom branch via GitHub Actions.
# Requires: gh CLI (https://cli.github.com/) installed and authenticated.
#
# Usage:
#   ./scripts/build_images.sh <BRANCH>
#   ./scripts/build_images.sh <BRANCH>
#
set -euo pipefail

BRANCH=${1:-}

if [ -z "$BRANCH" ]; then
  echo
  echo "Usage: ./scripts/build_images.sh <BRANCH>"
  echo
  echo "  BRANCH: Git branch, tag, or SHA to build images from."
  echo "          The branch must be pushed to the remote."
  echo
  echo "Examples:"
  echo "  ./scripts/build_images.sh main"
  echo "  ./scripts/build_images.sh my-feature-branch"
  echo
  exit 1
fi

# --- Check gh CLI ---
if ! command -v gh &> /dev/null; then
  echo "Error: GitHub CLI (gh) is not installed."
  echo "Install it: https://cli.github.com/"
  if [[ "${OSTYPE:-}" == darwin* ]]; then
    echo "  brew install gh"
  fi
  exit 1
fi

# Check gh is authenticated
if ! gh auth status &> /dev/null; then
  echo "Error: GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

# --- Get repo info ---
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

echo "Triggering Docker image builds..."
echo "  Repo:   $REPO"
echo "  Branch: $BRANCH"
echo

# --- Trigger the workflow ---
gh workflow run _docker-images-custom.yml \
  --ref main \
  -f branch_ref="$BRANCH"

echo
echo "Build triggered successfully!"
echo
echo "Monitor progress:"
echo "  https://github.com/$REPO/actions/workflows/_docker-images-custom.yml"
echo
echo "Or via CLI:"
echo "  gh run list --workflow=_docker-images-custom.yml --limit=5"
echo
