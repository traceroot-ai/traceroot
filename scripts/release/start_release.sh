#!/bin/bash
#
# This script:
# 1. creates a new release branch `vX.Y` from origin/master, and
# 2. generates the first tag `vX.Y.0` on the minor version `vX.Y`.
#

set -e

VERSION=$1
BASE_REF=${2:-origin/master}

if [[ $# -lt 1 || $# -gt 2 ]]; then
    echo
    echo "Usage: ./scripts/release/start_release.sh <VERSION> [BASE_REF]"
    echo
    echo "  VERSION:         The major version of the release, such as 'v1.9'"
    echo "  BASE_REF:        (optional) The git branch or commit that should"
    echo "                   be used to create the release branch. Default: origin/master"
    echo
    exit 1
fi

# Validate version format
if [[ ! "$VERSION" =~ ^v[0-9]\.[0-9]+$ ]]; then
    echo "Official release branches should have format such as v1.9 but got $VERSION"
    echo
    read -p "Do you wish to continue anyway? [Y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        false
    fi
    NOTES_ARG=""
else
    # If version is vX.0 for a new X, then we need to find the highest v(X-1).Y:
    if [[ "$VERSION" =~ ^v[0-9]+\.0$ ]]; then
        PREV_PREFIX=$(echo ${VERSION} | awk -F. '{print "v" substr($1, 2) - 1}')
        PREV_VERSION=$(git tag -l | grep -E $PREV_PREFIX | grep -E "^v[0-9]+\.[0-9]+\.[0]$" | sort -V | tail -n 1)
    else
        PREV_VERSION=$(echo ${VERSION} | awk -F. -v OFS=. '{$NF -= 1 ; print}').0
    fi
    NOTES_ARG="--notes-start-tag ${PREV_VERSION}"
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
GIT_VERSION=$(gh --version | perl -pe 'if(($v)=/([0-9]+([.][0-9]+)+)/){print"$v\n";exit}$_=""')
if ! { echo "2.28.0"; echo "$GIT_VERSION"; } | sort -V -C; then
    gh --version
    echo "You are running an out of date version of github cli. Please upgrade to at least v2.28.0"
    false
fi

# Fetch origin/master, and confirm that this is OK
git fetch origin
git checkout $BASE_REF

git log -1
BRANCH=${VERSION}

echo
echo "We will create a new release branch '${BRANCH}' based on the above commit."
echo

read -p "Do you wish to continue? [Y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    false
fi

# Fail if the release branch already exists
if git show-ref -q --heads origin/${BRANCH}; then
    echo "Release branch already exists at 'origin/${BRANCH}'"
    echo "Please checkout the '${BRANCH}' branch and use the following script to make hotfixes:"
    echo
    echo "  ./scripts/release/cherry_pick.sh <PULL_REQUEST>"
    echo
    false
fi

# Create release branch and tag
TAG=${VERSION}.0
LATEST_TAG=${VERSION}

git checkout -b $BRANCH
git push origin $BRANCH
git tag $TAG
git push origin $TAG
