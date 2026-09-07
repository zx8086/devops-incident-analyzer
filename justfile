# justfile (repo root)
# Operator recipes for the pi-coms hub and console delegate to the package
# justfile, which runs with packages/pi-coms as its working directory (just's
# default for -f) so its relative paths and dotenv-load keep working.

set positional-arguments

pi_just := "just -f packages/pi-coms/justfile"

default:
    @just --list

# Start a local hub (kills a previous listener on PI_COMS_NET_PORT first)
coms-net-server *args:
    {{pi_just}} coms-net-server "$@"

# Start a LAN-exposed local hub
coms-net-server-lan *args:
    {{pi_just}} coms-net-server-lan "$@"

# Open a Pi console session against a LOCAL hub: just coms <cname> [pi args]
coms *args:
    {{pi_just}} coms "$@"

# Pi console against a deployed environment's hub: just coms-env <dev|prd> <cname>
coms-env *args:
    {{pi_just}} coms-env "$@"

# just token-create <principal> "<names>" <kind> [profile]
token-create *args:
    {{pi_just}} token-create "$@"

# just token-revoke <principal> [profile]
token-revoke *args:
    {{pi_just}} token-revoke "$@"

# just token-list [profile]
token-list *args:
    {{pi_just}} token-list "$@"

# SSM port-forward to an environment's hub: just hub-tunnel <dev|prd> [local-port]
hub-tunnel *args:
    #!/usr/bin/env bash
    set -euo pipefail
    # Guard the OLD call shape here, not in the package recipe: with 3+ words
    # just parses the extras as further recipe invocations ("does not contain
    # recipe `8787`") before any recipe body runs.
    if [ "$#" -gt 2 ]; then
      echo "hub-tunnel now takes an ENVIRONMENT, not <profile> <region> <port>: just hub-tunnel <dev|prd> [local-port]" >&2
      echo "(profile, region and hub port come from packages/pi-coms/deploy/fleet.yaml)" >&2
      exit 1
    fi
    exec {{pi_just}} hub-tunnel "$@"

# Regenerate packages/pi-coms/AGENTS.md from agents/pi-fleet (SIO-1649)
sync-persona:
    {{pi_just}} sync-persona

# just fleet <cmd> [names]: manifest-driven fleet deploy (SIO-1653)
fleet *args:
    {{pi_just}} fleet "$@"
