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
| `HOST` | `0.0.0.0` | bind address |
| `PLAY_ROOT` | the repository root | the site's static files |
| `PLAY_DATA` | `~/.local/share/pbsb-play/session.json` | the session file (survives a restart) |

"Treff beenden" in the app deletes the session on the hub. Stop the hub with Ctrl+C.
