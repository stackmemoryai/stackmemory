# StackMemory Portal — Run Claude Code 24/7

> A VPS, Claude Code in tmux, a Tailscale VPN, and a vibecoded web terminal.
> Your agents run 24/7. You experience life.

The **portal** is a self-hosted, browser-based terminal into a persistent
`tmux` session running Claude Code. Put it on a small VPS behind Tailscale and
you get a private, always-on coding agent you can check on from your phone,
laptop, or tablet — no exposed ports, no SaaS in the middle.

```
┌── Hetzner CX22 (~€4.5/mo) ───────────────────────────┐
│                                                       │
│   tmux session "claude"  ──►  claude (max plan)       │
│        ▲                                              │
│        │ node-pty                                     │
│   stackmemory portal  ──►  :7799  (xterm.js + WS)     │
│        ▲                                              │
└────────┼──────────────────────────────────────────────┘
         │  Tailscale (WireGuard, 100.x address)
         ▼
   Your browser  →  http://100.x.y.z:7799/?token=…
```

**Why this shape?**

- **tmux** keeps the agent alive when you close the browser or the portal
  restarts. Reattach over SSH any time.
- **Tailscale** gives you an encrypted private address with zero open ports —
  no nginx, no TLS certs, no firewall holes.
- **node-pty + xterm.js** stream the real terminal, so Claude Code's TUI,
  permissions prompts, and colors all work exactly as they do locally.

---

## Quick start (Hetzner cloud-init)

The fastest path — the server provisions itself on first boot.

1. Create a Tailscale **auth key** at
   <https://login.tailscale.com/admin/settings/keys> (reusable, ephemeral off).
2. In Hetzner Cloud, **Add Server** → Ubuntu 24.04 → type **CX22**.
3. Expand **Cloud config** and paste
   [`scripts/portal/cloud-init.yaml`](../../scripts/portal/cloud-init.yaml).
   Set `TS_AUTHKEY=` to your key inside the pasted config.
4. Create the server. After ~2 minutes it's on your tailnet.

Then finish the two interactive steps over SSH:

```bash
ssh root@<hetzner-ip>

# Authenticate Claude Code (max plan) once — it caches credentials in ~/.claude
tmux attach -t claude     # log in, approve, then detach with: Ctrl-b d

# Grab your access URL + token
journalctl -u stackmemory-portal --no-pager | grep -i token
```

Open `http://100.x.y.z:7799/?token=…` (the `100.x` Tailscale address) from any
device signed into your tailnet. You're now looking at your agent.

---

## Manual setup

Prefer to do it by hand, or installing on an existing box?

```bash
# On the VPS (Debian/Ubuntu):
curl -fsSL https://raw.githubusercontent.com/stackmemoryai/stackmemory/main/scripts/portal/setup.sh | bash

sudo tailscale up                       # join your tailnet (prints an auth URL)
tmux new -s claude 'claude'             # authenticate Claude, then Ctrl-b d to detach
stackmemory portal start --cwd ~/work   # start the portal (prints the URL + token)
```

For 24/7 operation, install the service:

```bash
sudo cp scripts/portal/stackmemory-portal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stackmemory-portal
journalctl -u stackmemory-portal -f     # tail logs (the access URL is printed here)
```

---

## The CLI

```bash
stackmemory portal start      # start the server (foreground; systemd runs this)
stackmemory portal status     # show status + the access URL for this machine
stackmemory portal stop       # stop a running portal
stackmemory portal token      # print the access token
```

`start` options:

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `7799` | Port to listen on |
| `--host <h>` | `0.0.0.0` | Interface to bind (reachable over the tailnet) |
| `--session <name>` | `claude` | tmux session name |
| `--command <cmd>` | `claude` | Command tmux runs (`"claude --resume"`, a wrapper, etc.) |
| `--cwd <dir>` | cwd | Working directory for the session |
| `--no-auth` | off | Disable the token (rely on Tailscale alone) |

The portal runs `tmux new-session -A -s <session> <command>`: it **attaches** to
the session if it already exists, otherwise creates it. Multiple browser tabs
share the same live session. Closing a tab detaches but never kills the agent.

---

## Security model

- **Network:** binding to `0.0.0.0` is safe *because* the box only has a public
  IP plus its Tailscale address — keep the cloud firewall closed to `:7799` and
  reach it exclusively over the tailnet. (Hetzner's firewall: allow `22` from
  your IP, deny the rest.)
- **Token:** a 48-char token is generated on first start and stored at
  `~/.stackmemory/portal/token` (`chmod 600`). It's required on both the page
  load (`?token=`) and the WebSocket handshake. Rotate it by deleting the file
  and restarting. `--no-auth` turns this off if you trust your tailnet ACLs.
- **No inbound ports on the internet.** Tailscale is WireGuard point-to-point;
  there is nothing to port-scan.

> Treat the token like an SSH key — anyone with the URL gets a live shell as the
> user running the portal.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `tmux is not installed` | `sudo apt install tmux` |
| Page loads but terminal is blank / "Cannot start session" | `node-pty` missing on the server: `npm install -g node-pty` (needs `build-essential` + `python3`) |
| `401 Unauthorized` | Append `?token=<token>` to the URL (`stackmemory portal token`) |
| Can't reach `100.x` address | `tailscale status` on both ends; make sure your client is logged into the same tailnet |
| Claude asks to log in every time | Authenticate once inside the tmux session so credentials land in `~/.claude`; ensure systemd `HOME=` points at that user's home |
| Agent died but portal is up | `tmux attach -t claude` to inspect; the portal recreates the session on next connect |

---

## Files

| Path | Purpose |
|------|---------|
| `src/features/portal/server.ts` | Express + Socket.io + node-pty bridge |
| `src/features/portal/ui.ts` | Embedded xterm.js terminal UI |
| `src/cli/commands/portal.ts` | `stackmemory portal` command |
| `scripts/portal/setup.sh` | One-shot VPS installer |
| `scripts/portal/cloud-init.yaml` | Hetzner first-boot provisioning |
| `scripts/portal/stackmemory-portal.service` | systemd unit for 24/7 operation |
