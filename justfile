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

# Pi console against a deployed hub: just coms-env <env|profile|account> <cname>
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

# SSM port-forward to a hub: just hub-tunnel <env|profile|account> [--local-port N]
hub-tunnel *args:
    {{pi_just}} hub-tunnel "$@"

# Regenerate packages/pi-coms/AGENTS.md from agents/pi-fleet (SIO-1649)
sync-persona:
    {{pi_just}} sync-persona

# just fleet <cmd> [names]: manifest-driven fleet deploy (SIO-1653)
fleet *args:
    {{pi_just}} fleet "$@"
