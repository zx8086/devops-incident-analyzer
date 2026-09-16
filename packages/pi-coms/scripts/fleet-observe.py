#!/usr/bin/env python3
# scripts/fleet-observe.py
# SIO-1762: decode `herdr terminal session observe` records arriving over an
# SSM interactive session and paint them on this terminal. Read-only by
# construction: nothing here writes back to the session.
import base64
import json
import sys

out = sys.stdout.buffer
for raw in sys.stdin.buffer:
    line = raw.strip()
    if not line.startswith(b"{"):
        continue  # SSM banner, prompt echo, keepalives
    try:
        rec = json.loads(line)
    except ValueError:
        continue  # a frame split across PTY writes; the next full frame repaints
    if rec.get("type") == "terminal.closed":
        out.write(b"\x1b[0m\r\n[observer closed: %s]\r\n" % str(rec.get("reason", "")).encode())
        out.flush()
        break
    data = rec.get("bytes")
    if data:
        out.write(base64.b64decode(data))
        out.flush()
