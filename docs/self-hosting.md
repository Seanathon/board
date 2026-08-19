# Self-hosting board-oss

Four things bite on a real deployment. Each one fails quietly:

- **The default bind is `127.0.0.1`.** If your reverse proxy runs on another host, it
  gets a 502 while board-oss looks healthy.
- **Changes to the installed systemd unit are reverted on upgrade.** The install
  script rewrites it. Use a drop-in.
- **systemd's `PATH` is minimal**, so a CLI agent your shell finds, the service does
  not.
- **A CLI agent's login is interactive**, and must run as the service user.

The [README](../README.md) covers installation. This document covers the decisions and
failure modes that come after it.

Examples use a Proxmox LXC, which is what board-oss is sized for. Only the container
section is Proxmox-specific; the rest applies to any Debian host.

---

## Sizing and container prerequisites

### How big the container needs to be

board-oss itself is small. **Headless Chromium is what sizes the box** — it spikes
during capture and is idle the rest of the time.

| | Minimum | Comfortable |
|---|---|---|
| Cores | 2 | 4 |
| RAM | 1 GB | 4 GB |
| Root disk | 8 GB | 16 GB |

Screenshots dominate disk growth over time. Budget roughly **0.5–1 MB per captured
item** on top of the base install; a 150-item collection runs to about 100 MB.

### Unprivileged LXC features

Use an unprivileged container. It needs two features that are off by default:

```text
features: nesting=1,keyctl=1
```

Without them Chromium and Node hit permission errors that look unrelated to either.
Set them at creation time or in the container config.

### Node version

`package.json` deliberately declares **no `engines.node`**, so nothing will stop you
running an unsupported version. Use **Node LTS**. `scripts/install-lxc.sh` installs
NodeSource LTS when `node` is missing, which is the version the project is tested on.

`better-sqlite3` ships a prebuilt binary for glibc Linux on Node LTS, so no compiler
is needed. If you end up on a combination with no prebuilt, install
`build-essential python3` first.

---

## Binding and reverse proxies

board-oss ships **no authentication of its own** — auth and TLS are the reverse
proxy's job. See the README's security section for why. Where that proxy runs decides
how board-oss must bind.

### The proxy on the same host

Nothing to do. The shipped unit binds `127.0.0.1:8080`, the proxy connects over
loopback, and the port is unreachable from the network. This is the default because
it is the safe one.

### The proxy on a different host

The proxy returns 502, board-oss looks healthy, and `/healthz` passes from inside the
container. Everything points at the proxy, and the proxy is fine.

`127.0.0.1` is unreachable from anywhere but the container itself, so board-oss must
bind an address the proxy can route to.

**Do not edit `deploy/board-oss.service` or the installed unit file directly.**
`scripts/install-lxc.sh` rewrites `/etc/systemd/system/board-oss.service`, so an
upgrade silently reverts your change and the service goes unreachable again. Use a
systemd drop-in, which survives:

```bash
systemctl edit board-oss
```

```ini
[Service]
Environment=HOST=0.0.0.0
```

```bash
systemctl restart board-oss
```

Confirm it is listening off-loopback:

```bash
ss -ltnp | grep 8080          # expect 0.0.0.0:8080, not 127.0.0.1:8080
```

board-oss logs a one-line warning at boot when it binds a non-localhost address. That
warning is correct and you should not silence it: **the port now has no
authentication in front of it.** Restrict it at the network layer so only the proxy
can reach it — a host firewall rule, a container firewall, or a private VLAN.

A minimal Caddy site block for the proxy host:

```caddyfile
board.example.internal {
    reverse_proxy http://<board-host-ip>:8080
    encode gzip
}
```

If you run split-horizon DNS, point the name at the **proxy**, not at board-oss.

---

## Enabling AI

board-oss runs fully without AI — enrichment shows a dignified "disabled" state rather
than failing. There are two ways to turn it on.

### An HTTP provider (API key)

The simpler of the two. Add the provider env with a drop-in and restart:

```ini
[Service]
Environment=LLM_BASE_URL=https://api.example.com/v1
Environment=LLM_API_KEY=…
Environment=LLM_MODEL=…
```

### A CLI agent (`LLM_AGENT`)

This uses a coding-agent CLI you already pay for (`claude`, `codex`) instead of an API
key. It works. Four things can go wrong first, and none of them produce an obvious
error message.

board-oss spawns the agent **by bare command name**, with `cwd` set to a temporary
directory and a 120-second wall-clock timeout (`src/llm/cli-provider.ts`). That one
sentence explains three of the four problems.

**1. The binary must be on systemd's `PATH`, which is minimal.**

Your login shell finds `claude` because your profile puts it on `PATH`. systemd does
not read your profile. The spawn fails with `ENOENT` and surfaces as a generic
enrichment failure. The shipped unit sets no `PATH` at all, so set one:

```ini
[Service]
Environment=PATH=/var/lib/board-oss/.local/bin:/usr/local/bin:/usr/bin:/bin
```

Verify it the way the app will, as the service user rather than as yourself:

```bash
sudo -u boardoss env PATH=/var/lib/board-oss/.local/bin:/usr/local/bin:/usr/bin:/bin \
  claude --version
```

**2. The agent needs a writable `HOME`, and it must be the service user's.**

The unit already points `HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` at
`DATA_DIR` — originally so headless Chromium could write its profile under
`ProtectSystem=strict`. Agent CLIs store their credentials in the same place, so this
works in your favor, with one catch: **you must authenticate as the service user
with that same `HOME`**, or the credentials land somewhere the service can't read.

```bash
sudo -u boardoss env HOME=/var/lib/board-oss XDG_CONFIG_HOME=/var/lib/board-oss/.config \
  claude   # then complete the interactive login
```

**3. Authentication is interactive and cannot be scripted.**

Budget for a human at a terminal; no install script can do this step for you. Until
it is done, enrichment fails and every item lands in the `error` state with a visible
reason — which is intended, not a bug.

**4. Running the agent as `root` does not test what the service does.**

If you invoke the agent from a root shell, it inherits root's `HOME` and working
directory. The service user typically cannot traverse `/root`, so the agent's own
tooling fails in ways that have nothing to do with board-oss. Always reproduce as the
service user.

#### A wrapper, if you want one

If you would rather not thread `PATH` and `HOME` through the unit, install a wrapper
that normalizes the environment and put *that* on the service's `PATH`:

```bash
# /usr/local/bin/claude   root:root 0755
#!/usr/bin/env bash
set -euo pipefail
export HOME=/var/lib/board-oss
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
cd "$HOME"
# If invoked as root, drop to the service user so credentials and cwd match the app.
if [ "$(id -u)" = "0" ]; then
  exec runuser -u boardoss -- env HOME="$HOME" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
    "$HOME/.local/bin/claude" "$@"
fi
exec "$HOME/.local/bin/claude" "$@"
```

This also makes the agent behave the same whether you invoke it by hand or the
service invokes it, which removes a whole class of "works when I run it" confusion.

#### Capture takes longer than you expect

Capture and the AI read share a single job under one budget, `CAPTURE_TIMEOUT_MS`,
which defaults to **180 seconds**. A CLI agent routinely takes 90–100 seconds for a
single item, so the budget is not generous — it is sized for exactly this. If you use
a slow local model, raise it:

```ini
[Service]
Environment=CAPTURE_TIMEOUT_MS=600000
```

An item that exceeds the budget lands in the `error` state reading "timed out", with
a **Try again** button on the card. Nothing is lost; the page has already been
captured and only the AI read is missing.

---

## Backups

Two different backups, and they are not interchangeable.

### The collection itself

board-oss can export everything — every board, every item, and the image files — as a
single `.tar`. In the app: the button in the bottom-right corner → **Your data** →
**Download a backup**. Or directly:

```bash
curl -o board-backup.tar http://127.0.0.1:8080/api/backup
```

It is a plain ustar archive holding `manifest.json` plus a `screenshots/` directory,
so you can inspect it with ordinary tools and without this application:

```bash
tar -tvf board-backup.tar | head
```

Restoring is **non-destructive by construction**: boards that already exist keep
their name, view and fields, and items dedupe on their id rather than being
overwritten. Restoring your own backup over a live install is a no-op, which makes it
safe to test.

```bash
curl -X POST http://127.0.0.1:8080/api/backup \
  -H 'Content-Type: application/x-tar' --data-binary @board-backup.tar
```

### The whole container

A container snapshot (Proxmox Backup Server, `vzdump`, ZFS) protects the install, the
systemd configuration and the agent credentials — things the collection export
deliberately does not carry. Run both.

### Secrets in snapshots

If you store an API key on the box — in a drop-in, a wrapper, or a key file — that
container snapshot is now secret-bearing. Either exclude the key path from the backup
job and document how to recreate it:

```bash
vzdump <ctid> --storage <store> --mode snapshot \
  --exclude-path /etc/board-oss/anthropic.key
```

…or accept that the snapshot must be protected as a credential. Decide deliberately
rather than by default. A key file should be `root:boardoss` mode `0640` so the
service can read it and nothing else can.

---

## Upgrading

If you cloned the repo straight to the app directory (`git clone … /opt/board-oss`,
then ran the installer from inside it), `/opt/board-oss` is a working git checkout and
upgrading is:

```bash
cd /opt/board-oss
git pull
npm ci --omit=dev
systemctl restart board-oss
```

If you instead ran the installer from a checkout somewhere else, the app directory is
a **copy** with no `.git`, so pull in your original checkout and re-run
`scripts/install-lxc.sh` with the same `APP_DIR` / `DATA_DIR` / `PORT` values.

`DATA_DIR` is separate from the code directory, so upgrades never touch your data.
There is no build step — the service runs TypeScript through `tsx` at runtime.

Anything you changed **inside** the installed unit file is lost on a re-run of the
install script. Drop-ins (`systemctl edit board-oss`) survive; use them for every
local change.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Proxy returns 502, `/healthz` passes inside the container | Bound to `127.0.0.1` with the proxy on another host | Set `HOST=0.0.0.0` via a drop-in, firewall the port |
| A local change to the service reverted after an upgrade | The install script rewrites the unit file | Move the change into `systemctl edit board-oss` |
| Every item fails enrichment immediately | Agent binary not on systemd's `PATH` | Set `Environment=PATH=…`; verify with `sudo -u boardoss … --version` |
| Enrichment fails only under systemd, works by hand | Authenticated as the wrong user, or a different `HOME` | Re-authenticate as the service user with `HOME=/var/lib/board-oss` |
| Items fail with "timed out" | Capture + AI read exceeded `CAPTURE_TIMEOUT_MS` | Raise it; retry the item with **Try again** on the card |
| Capture fails, no screenshot | Chromium missing, or LXC lacks `nesting=1,keyctl=1` | Install the Debian `chromium` package; add the container features |
| Cards show but images 404 after a move | The collection export carries paths, the archive carries bytes | Restore from the `.tar`, not from a JSON export |

Useful commands:

```bash
systemctl status board-oss
journalctl -u board-oss -f
curl -fsS http://127.0.0.1:8080/healthz     # -> {"ok":true}
ss -ltnp | grep 8080
```

`/healthz` is a pure liveness probe with no database check, so it stays up during a
SQLite checkpoint rather than flapping and tripping a restart loop. It tells you the
process is alive; it does not tell you enrichment works.
