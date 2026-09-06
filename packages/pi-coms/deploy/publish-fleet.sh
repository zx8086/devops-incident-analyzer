#!/usr/bin/env bash
# packages/pi-coms/deploy/publish-fleet.sh [--stage-only] <s3-bucket> [profile]
#
# Build and upload the fleet bundle: a git archive of the packages/pi-coms
# subtree at HEAD plus vendored node_modules (all deps are pure JS, so the
# vendor tree is platform-independent). Hosts running in S3 bundle mode
# converge on it within the State Manager window, or immediately via Run
# Command.
#
#   ./packages/pi-coms/deploy/publish-fleet.sh pi-coms-dist-<hub-account-id> eu-shared-services-dev
#
# --stage-only builds the stage (in PI_COMS_STAGE_DIR when set), prints its
# path and exits without uploading; the dirty-tree check is skipped because it
# is a local dry run. PI_FLEET_PERSONA_DIR, when set, is copied to
# vendor/pi-fleet/ in the stage (the persona exporter hook, SIO-1649).
set -euo pipefail

STAGE_ONLY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --stage-only) STAGE_ONLY=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
BUCKET="${ARGS[0]:-}"
PROFILE="${ARGS[1]:-}"
if [ "$STAGE_ONLY" = 0 ] && [ -z "$BUCKET" ]; then
  echo "usage: publish-fleet.sh [--stage-only] <s3-bucket> [aws-profile]" >&2
  exit 1
fi
PROFILE_ARGS=()
[ -n "$PROFILE" ] && PROFILE_ARGS=(--profile "$PROFILE")

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "$PKG_ROOT" rev-parse --show-toplevel)"
PKG_PREFIX="$(git -C "$PKG_ROOT" rev-parse --show-prefix)"
PKG_PREFIX="${PKG_PREFIX%/}"
VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
if [ "$STAGE_ONLY" = 0 ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- "$PKG_PREFIX")" ]; then
  echo "refusing to publish: uncommitted changes in tracked files under $PKG_PREFIX" >&2
  exit 1
fi

if [ -n "${PI_COMS_STAGE_DIR:-}" ]; then
  STAGE="$PI_COMS_STAGE_DIR"
  mkdir -p "$STAGE"
else
  STAGE="$(mktemp -d)"
  [ "$STAGE_ONLY" = 1 ] || trap 'rm -rf "$STAGE"' EXIT
fi

# The subtree only, with the packages/pi-coms prefix stripped: the bundle root
# is the package root, exactly what the bootstrap and the hub userdata expect.
git -C "$REPO_ROOT" archive "HEAD:$PKG_PREFIX" | tar -x -C "$STAGE"
# The workspace root owns the only lockfile, so the staged tree gets a
# standalone one before the frozen production install the hosts repeat.
# Install output goes to stderr so --stage-only prints only the stage path.
(cd "$STAGE" && bun install --lockfile-only >&2 && bun install --frozen-lockfile --production --omit=peer >&2)
# The monitor and hub runtime deps live in scripts/package.json (SIO-1632).
(cd "$STAGE/scripts" && bun install --frozen-lockfile --production >&2)
if [ -n "${PI_FLEET_PERSONA_DIR:-}" ]; then
  mkdir -p "$STAGE/vendor"
  cp -R "$PI_FLEET_PERSONA_DIR" "$STAGE/vendor/pi-fleet"
fi
echo "$VERSION" > "$STAGE/.bundle-version"

if [ "$STAGE_ONLY" = 1 ]; then
  echo "$STAGE"
  exit 0
fi

tar -czf "$STAGE.tar.gz" -C "$STAGE" .
aws s3 cp "$STAGE.tar.gz" "s3://$BUCKET/fleet/bundle.tar.gz" "${PROFILE_ARGS[@]}"
printf '%s' "$VERSION" | aws s3 cp - "s3://$BUCKET/fleet/version" "${PROFILE_ARGS[@]}"
rm -f "$STAGE.tar.gz"

echo "published fleet bundle $VERSION to s3://$BUCKET/fleet/"
echo "hosts converge within 30 min; immediate rollout:"
echo "  aws ssm send-command --targets Key=tag:Project,Values=pi-coms-net \\"
echo "    --document-name AWS-RunShellScript --parameters 'commands=[\"/usr/local/bin/pi-coms-update\"]' ${PROFILE_ARGS[*]:-}"
