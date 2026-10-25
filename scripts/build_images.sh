#!/bin/bash
# scripts/build_images.sh
#
# Trigger Docker image builds for a custom branch via GitHub Actions.
# Requires: gh CLI (https://cli.github.com/) installed and authenticated.
#
# Usage:
#   ./scripts/build_images.sh <BRANCH> [staging|production]
#
set -euo pipefail

BRANCH=${1:-}
ENVIRONMENT=${2:-staging}

if [ -z "$BRANCH" ]; then
  echo
  echo "Usage: ./scripts/build_images.sh <BRANCH> [staging|production]"
  echo
  echo "  BRANCH:      Git branch or tag to build images from, pushed to the remote."
  echo "               A bare commit SHA will not work: gh dispatches by ref."
  echo "               To build one, tag it first."
  echo "  ENVIRONMENT: Which ECR repos to push to. Defaults to staging."
  echo
  echo "Examples:"
  echo "  ./scripts/build_images.sh main"
  echo "  ./scripts/build_images.sh my-feature-branch"
  echo "  ./scripts/build_images.sh main production"
  echo
  exit 1
fi

case "$ENVIRONMENT" in
  staging|production) ;;
  *) echo "Error: environment must be 'staging' or 'production', got '$ENVIRONMENT'"; exit 1 ;;
esac

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
echo "  Repo:        $REPO"
echo "  Branch:      $BRANCH"
echo "  Environment: $ENVIRONMENT"
echo "  ECR repos:   traceroot-${ENVIRONMENT}-*"
echo

if [ "$ENVIRONMENT" = "production" ]; then
  read -r -p "Push to the PRODUCTION registry? [y/N] " reply
  case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac
  echo
fi

# --- Trigger the workflow ---
# --ref both runs and checks out BRANCH, so the sha tag matches the code in the
# image. Do not dispatch from one ref while building another: that tags the
# image with the dispatching ref's sha, overwriting it in a mutable-tag registry.
gh workflow run docker-images.yml \
  --ref "$BRANCH" \
  -f environment="$ENVIRONMENT"

echo
echo "Build triggered successfully!"
echo
echo "Monitor progress:"
echo "  https://github.com/$REPO/actions/workflows/docker-images.yml"
echo
echo "Or via CLI:"
echo "  gh run list --workflow=docker-images.yml --limit=5"
echo
