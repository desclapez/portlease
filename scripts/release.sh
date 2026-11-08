#!/bin/sh
# Publish the version in package.json to npm from an up-to-date, clean main, then tag it.
# Bump the version in a PR first (npm version patch|minor --no-git-tag-version) and merge it.
#
#   npm run release              checks, tests, publish, wait for npm, tag, push the tag
#   npm run release -- --dry-run everything up to the publish, changes nothing

set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "release: $*" >&2
  exit 1
}

dry_run=false
case "${1:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *) fail "unknown option $1 (only --dry-run)" ;;
esac

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
tag="v$version"

[ "$(git branch --show-current)" = main ] || fail "run it from main (you are on $(git branch --show-current))"
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean"
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main differs from origin/main: git pull first"
node_major=$(node -p "process.versions.node.split('.')[0]")
[ "$node_major" = "$(cut -d. -f1 .nvmrc)" ] || fail "Node $node_major is active but .nvmrc asks for $(cat .nvmrc): run nvm use"
npm whoami >/dev/null 2>&1 || fail "not logged in to npm: run npm login"
[ -z "$(npm view "$name@$version" version 2>/dev/null)" ] || fail "$name@$version is already on npm: bump the version in a PR"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && fail "the tag $tag already exists"

commit=$(git rev-parse HEAD)
echo "release: $name@$version from $(git rev-parse --short HEAD)"

npm ci --silent
npm run typecheck
npm test
npm pack --dry-run 2>&1 | grep -E 'total files|package size'

if $dry_run; then
  echo "release: dry run, nothing was published or tagged"
  exit 0
fi

# npm asks for the 2FA code here.
npm publish

# npm can take a few minutes to show a new version. Only tag once it is really there.
echo "release: waiting for npm to show $name@$version..."
waited=0
until [ -n "$(npm view "$name@$version" version 2>/dev/null)" ]; do
  [ "$waited" -lt 900 ] || fail "$name@$version is not visible after 15 minutes. Once it is, run: git tag -a $tag -m $tag $commit && git push origin $tag"
  sleep 15
  waited=$((waited + 15))
done

git tag -a "$tag" -m "$tag" "$commit"
git push -q origin "$tag"
echo "release: $name@$version is on npm and $tag points to $(git rev-parse --short "$commit")"
