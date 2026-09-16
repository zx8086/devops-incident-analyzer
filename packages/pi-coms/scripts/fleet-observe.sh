#!/usr/bin/env bash
# scripts/fleet-observe.sh
# SIO-1762: watch spokes READ-ONLY from Herdr. Each pane streams a spoke's live
# Pi screen through `herdr terminal session observe` on the host, carried over
# SSM AWS-StartInteractiveCommand. No input, resize, scroll or takeover
# authority ever reaches the agent: operators do not speak to the agents.
# Observers do not resize the pane either (verified 2026-09-16), unlike an
# attached client, which would shrink the agent's screen to the pane size.
#
#   fleet-observe.sh layout <hub-selector>   split the calling Herdr pane right and
#                                            stack one observer per spoke of that hub
#   fleet-observe.sh watch <spoke>           what each pane runs: stream one spoke here
#
# Manifest: deploy/fleet.yaml next to this package, or $PI_COMS_MANIFEST.
# Needs a fresh SSO login for the spoke profiles.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST="${PI_COMS_MANIFEST:-$HERE/../deploy/fleet.yaml}"
DECODER="$HERE/fleet-observe.py"

# Runs on the host as piagent with cols and rows as $1 $2. Shipped base64 so no
# quoting has to survive the pane shell, the aws CLI and the SSM document.
REMOTE_B64=$(base64 <<'EOF' | tr -d '\n'
pane=$(herdr agent list | python3 -c 'import json,sys; a=json.load(sys.stdin)["result"]["agents"]; print(a[0]["pane_id"] if a else "")')
[ -n "$pane" ] || { echo "no Pi agent pane on this host"; exit 1; }
exec herdr terminal session observe "$pane" --cols "${1:-120}" --rows "${2:-40}"
EOF
)

spokes() { bun "$HERE/fleet-spokes.ts" "$MANIFEST" "$@"; }

# Runs inside the pane. Spoke hosts get replaced and their ids rotate, so the
# instance is resolved by its Name tag at launch time, never pinned.
watch() {
  local name=$1 profile region cols rows iid f
  read -r _ profile region < <(spokes --spoke "$name")
  cols=$(tput cols 2>/dev/null || echo 120); rows=$(tput lines 2>/dev/null || echo 40)
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  iid=$(aws ec2 describe-instances --profile "$profile" --region "$region" \
    --filters Name=tag:Name,Values=pi-agent-agent Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  [ -n "$iid" ] && [ "$iid" != None ] || { echo "no running pi-agent-agent instance in $profile" >&2; exit 1; }
  f="${TMPDIR:-/tmp}/fleet-observe-$name.json"
  printf '{"command":["echo %s | base64 -d | sudo -u piagent -i bash -s -- %s %s"]}' "$REMOTE_B64" "$cols" "$rows" > "$f"
  clear
  exec aws ssm start-session --profile "$profile" --region "$region" --target "$iid" \
    --document-name AWS-StartInteractiveCommand --parameters "file://$f" \
    | python3 "$DECODER"
}

layout() {
  local sel=$1 base cur k n i names
  [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_PANE_ID:-}" ] || { echo "layout needs to run inside a Herdr pane" >&2; exit 1; }
  mapfile -t names < <(spokes "$sel" | cut -d' ' -f1)
  n=${#names[@]}
  [ "$n" -gt 0 ] || { echo "no spokes bound to hub $sel in $MANIFEST" >&2; exit 1; }
  base=$HERDR_PANE_ID
  cur=$(herdr pane split "$base" --direction right --ratio 0.5 --no-focus | jq -r '.result.pane.pane_id')
  for ((i = 0; i < n; i++)); do
    herdr pane rename "$cur" "${names[$i]}" >/dev/null
    herdr pane run "$cur" "$(printf '%q watch %s' "$HERE/fleet-observe.sh" "${names[$i]}")"
    if ((i < n - 1)); then
      # --ratio is the share the ORIGINAL pane keeps, so each step keeps 1/k of
      # the remaining column and hands the rest to the next split: equal rows.
      k=$((n - i))
      cur=$(herdr pane split "$cur" --direction down --ratio "$(awk "BEGIN{print 1/$k}")" --no-focus | jq -r '.result.pane.pane_id')
    fi
  done
}

case "${1:-}" in
  layout) layout "${2:?hub selector}" ;;
  watch) watch "${2:?spoke name}" ;;
  *) echo "usage: $0 layout <hub-selector> | watch <spoke>" >&2; exit 2 ;;
esac
