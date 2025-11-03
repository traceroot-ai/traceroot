#!/bin/bash
#
# This script:
# 1. creates a new release branch `vX.Y` from origin/main, and
# 2. generates the first tag `vX.Y.0` on the minor version `vX.Y`.
#

set -e

VERSION=$1
BASE_REF=${2:-origin/main}

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo
    echo "Usage: ./scripts/release/start_release.sh <VERSION> [BASE_REF]"
    echo
    echo "  VERSION:         The version to release: 'vX.Y' or 'vX.Y.Z'"
    echo "  BASE_REF:        (optional) Commit/branch to base the release on."
    echo "                   For 'vX.Y', defaults to origin/main."
    echo "                   For 'vX.Y.Z', defaults to origin/main"
    echo
    exit 1
fi

# Validate version format and compute previous tag for notes
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
    echo "Version should be 'vX.Y' or 'vX.Y.Z' but got $VERSION"
    false
fi

IS_PATCH=0
if [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    IS_PATCH=1
    MAJOR_MINOR=$(echo "${VERSION}" | awk -F. '{print $1 "." $2}')
    PATCH_NUM=$(echo "${VERSION}" | awk -F. '{print $3}')
    PREV_VERSION=$(echo ${VERSION} | awk -F. -v OFS=. '{$NF -= 1 ; print}')
    if [[ -n "$PREV_VERSION" ]]; then
        NOTES_ARG="--notes-start-tag ${PREV_VERSION}"
    else
        NOTES_ARG=""
    fi
else
    MAJOR_MINOR="$VERSION"
    # If version is vX.0 for a new X, then we need to find the highest v(X-1).Y:
    if [[ "$VERSION" =~ ^v[0-9]+\.0$ ]]; then
        PREV_PREFIX=$(echo ${VERSION} | awk -F. '{print "v" substr($1, 2) - 1}')
        PREV_VERSION=$(git tag -l | grep -E $PREV_PREFIX | grep -E "^v[0-9]+\.[0-9]+\.[0-9]+$" | sort -V | tail -n 1)
    else
        PREV_VERSION=$(echo ${VERSION} | awk -F. -v OFS=. '{$NF -= 1 ; print}').0
    fi
    if [[ -n "$PREV_VERSION" ]]; then
        NOTES_ARG="--notes-start-tag ${PREV_VERSION}"
    else
        NOTES_ARG=""
    fi
fi

# Default BASE_REF for patch releases is main
if [[ $IS_PATCH -eq 1 && $# -lt 2 ]]; then
    BASE_REF="origin/main"
fi

# Install GitHub CLI if not available
if ! command -v gh &> /dev/null; then
    if [[ $OSTYPE == "darwin"* ]]; then
        echo "Installing github cli"
        brew install gh
    elif [[ $OSTYPE == "linux-gnu" ]]; then
        type -p yum-config-manager >/dev/null || sudo yum install yum-utils
        sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
        sudo yum -y install gh
    else
        echo "Please install github CLI: https://cli.github.com/"
        false
    fi
fi

# Check GitHub CLI version
GH_VERSION=$(gh --version | perl -pe 'if(($v)=/([0-9]+([.][0-9]+)+)/){print"$v\n";exit}$_=""')
if ! { echo "2.28.0"; echo "$GH_VERSION"; } | sort -V -C; then
    gh --version
    echo "You are running an out of date version of github cli. Please upgrade to at least v2.28.0"
    false
fi

# Fetch origin/main, and confirm that this is OK
git fetch origin
git checkout $BASE_REF

git log -1
if [[ $IS_PATCH -eq 1 ]]; then
    BRANCH=${MAJOR_MINOR}
else
    BRANCH=${VERSION}
fi

echo
if [[ $IS_PATCH -eq 1 ]]; then
echo "Creating new tag '${VERSION}' on '${BASE_REF}' based on the above commit."
else
echo "Creating new release branch '${BRANCH}' based on the above commit."
fi
echo

# Create release branch and/or tag
if [[ $IS_PATCH -eq 1 ]]; then
    TAG=${VERSION}
    # Ensure tag doesn't already exist locally or remotely
    if git rev-parse "$TAG" >/dev/null 2>&1 || git ls-remote --tags origin | grep -q "refs/tags/$TAG$"; then
        echo "Tag $TAG already exists. Aborting."
        false
    fi
    git tag $TAG
    git push origin $TAG
else
    TAG=${VERSION}.0
    # Ensure tag doesn't already exist locally or remotely
    if git rev-parse "$TAG" >/dev/null 2>&1 || git ls-remote --tags origin | grep -q "refs/tags/$TAG$"; then
        echo "Tag $TAG already exists. Aborting."
        false
    fi
    git checkout -b $BRANCH
    git push origin $BRANCH
    git tag $TAG
    git push origin $TAG
fi

# Make a new release
gh release create $TAG --verify-tag --generate-notes --title $TAG $NOTES_ARG
