# Spieltreff hub

Lets several devices work on one session: for example an iPad for check-in and a laptop that drives
the projector. No dependencies; needs Node 20 or newer.

Start it from the repository root:

    node hub/server.mjs

It prints the addresses to open. On the computer that runs it, use `http://localhost:15120/play/`
(sound plays there by default, and the app also works offline). Other devices on the same Wi-Fi use
the `.local` address or the IP address it prints.

| Variable | Default | What |
|---|---|---|
| `PORT` | `15120` | port |
| `HOST` | `::` (IPv6 and IPv4) | bind address; `0.0.0.0` for IPv4 only |
| `PLAY_ROOT` | the repository root | the site's static files |
| `PLAY_DATA` | `~/.local/share/pbsb-play/session.json` | the session file (survives a restart) |

"Treff beenden" in the app deletes the session on the hub. Stop the hub with Ctrl+C.

Updates: pages served by the hub load the newest files from the laptop on every reload (the offline
cache is only a fallback there). A page that still runs older files than another device has written
with gets "This page is out of date" and cannot save until it is reloaded, so an old page cannot undo
what it does not understand (for example the groups). One exception: a browser tab on the laptop
opened before 18 November 2026 still runs the old offline cache; reload it once with Cmd+Shift+R or
close that tab and open it again.
