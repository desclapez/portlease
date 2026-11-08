#!/bin/sh
# Release in two steps, because main is protected and a version bump has to go through a PR.
#
#   npm run release -- patch|minor|major   opens a PR that bumps the version (--dry-run only shows the new number)
#   npm run release                        after that PR is merged: checks, tests, publish, wait for npm, tag, push the tag
#   npm run release -- --dry-run           the second step up to the publish, changing nothing

set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "release: $*" >&2
  exit 1
}

dry_run=false
bump=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    patch | minor | major)
      [ -z "$bump" ] || fail "give only one of patch, minor or major"
      bump=$arg
      ;;
    *) fail "unknown argument $arg (patch, minor, major, --dry-run)" ;;
  esac
done

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

require_current_main() {
  [ "$(git branch --show-current)" = main ] || fail "run it from main (you are on $(git branch --show-current))"
  [ -z "$(git status --porcelain)" ] || fail "the working tree is not clean"
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main differs from origin/main: git pull first"
}

not_on_npm() {
  [ -z "$(npm view "$name@$1" version 2>/dev/null)" ] || fail "$name@$1 is already on npm"
}

if [ -n "$bump" ]; then
  next=$(node -e '
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.argv[1]);
    if (!m) process.exit(1);
    let [major, minor, patch] = m.slice(1).map(Number);
    if (process.argv[2] === "major") [major, minor, patch] = [major + 1, 0, 0];
    else if (process.argv[2] === "minor") [minor, patch] = [minor + 1, 0];
    else patch += 1;
    console.log(`${major}.${minor}.${patch}`);
  ' "$version" "$bump") || fail "cannot $bump-bump version $version (only plain X.Y.Z)"

  if $dry_run; then
    echo "release: $name $version -> $next ($bump)"
    exit 0
  fi

  require_current_main
  command -v gh >/dev/null || fail "gh is needed to open the PR"
  not_on_npm "$next"
  branch="release/v$next"
  git show-ref --verify --quiet "refs/heads/$branch" && fail "the branch $branch already exists"
  git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 && fail "the branch $branch already exists on origin"

  last=$(git describe --tags --abbrev=0 2>/dev/null || true)
  changes=$(git log --oneline -n 30 "${last:+$last..}main" | sed 's/^/- /')

  git switch -q -c "$branch"
  npm version "$next" --no-git-tag-version >/dev/null
  git commit -qam "chore: release $next"
  git push -q -u origin "$branch"
  gh pr create --base main --head "$branch" --title "chore: release $next" --body "Bumps $name from $version to $next ($bump).

Changes since ${last:-the start}:
$changes

After merging, from an up-to-date main: \`npm run release\`."
  git switch -q main
  echo "release: merge that PR, then run: git pull && npm run release"
  exit 0
fi

# Second step: publish what main already says.
tag="v$version"
require_current_main
node_major=$(node -p "process.versions.node.split('.')[0]")
[ "$node_major" = "$(cut -d. -f1 .nvmrc)" ] || fail "Node $node_major is active but .nvmrc asks for $(cat .nvmrc): run nvm use"
npm whoami >/dev/null 2>&1 || fail "not logged in to npm: run npm login"
not_on_npm "$version"
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
