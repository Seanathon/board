# board-oss

A lightweight, self-hostable, agent-native curation tool. Evolution of the `board`
prototype: Node/TypeScript + Fastify + SQLite, designed to run on a small Proxmox
LXC (~512MB–1GB RAM).

|  |  |  |
|:--:|:--:|:--:|
| ![Inspiration board: a visual grid of captured sites](docs/media/inspiration-grid.png) | ![Library board: a readable list of saved articles](docs/media/library-list.png) | ![Item detail with the AI design analysis](docs/media/item-design-read.png) |
| *Inspiration: a visual grid with an AI design read per card* | *Library: a readable list with AI summaries* | *Detail: the full per-item design analysis* |

## Quick start

```bash
npm install
npm run dev          # serves http://127.0.0.1:3141
```

Optional: migrate existing prototype data (`bookmarks.json` / `library.json`) into
SQLite:

```bash
npm run import:flat
```

## Configuration

All settings are environment variables with safe defaults (see `.env.example` for
the full annotated list). Empty/whitespace values are treated as unset.

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3141` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. **Localhost-only by default** (see Security). |
| `DATA_DIR` | `./data` | Persistent data root (SQLite DB + screenshots). |
| `CHROME_PATH` | autodetect | System Chromium/Chrome binary; autodetected on Linux when unset. |
| `LLM_AGENT` / `LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY` | unset | LLM provider. **Unset = no-AI** (enrichment disabled). With `LLM_AGENT=claude` and no `LLM_MODEL`, Board asks the CLI for **Sonnet** rather than inheriting your interactive default. |
| `CAPTURE_TIMEOUT_MS` | `180000` | Budget for one capture job — page capture **and** the AI read share it. A CLI agent routinely takes 90–100s; raise it for slow local models. |
| `BOARD_API_TOKEN` | unset | Bearer token for the `/api/v1` capture API. **Unset = the v1 API is off** (fail-closed). See [Integrations](docs/integrations.md). |

## Security & the reverse-proxy model

**board-oss v1 ships no built-in authentication — this is deliberate** (the
reverse-proxy-only auth model, AD7). The security posture is:

- **Localhost bind by default.** The server binds `127.0.0.1` unless you set an
  explicit, non-empty `HOST`. There is no other path to a non-localhost bind, and
  exposing the port logs a boot warning.
- **Put a reverse proxy in front for auth/TLS.** To expose board-oss beyond
  localhost, set `HOST=0.0.0.0` (or bind to a private interface) **and** front it
  with a reverse proxy that provides authentication and TLS — e.g.
  **Caddy + Authelia**, or a **Tailscale** tailnet. Do not expose `0.0.0.0`
  expecting app-level auth; there is none.
- **The internal capture contract is token-authed even on localhost** (Epic 6), so
  the security model stays coherent regardless of bind address.

> ⚠️ If you set `HOST` to a non-localhost address, board-oss logs a one-line
> warning at boot reminding you to put a reverse proxy / firewall in front.

`oslo` + `argon2` (app-level auth) are reserved for a future v2; v1's auth story is
the reverse proxy.

## Integrations

Every capture is an HTTP call, so any app, script, shortcut, or agent can drop a
link into your Inbox (or a specific board). Three entry points:

- **`POST /api/v1/items`** `{url, boardId?}` — the token-authed API (set
  `BOARD_API_TOKEN`); omit `boardId` and it lands in the Inbox.
- **`POST /share`** `url=…` — the no-auth PWA share target (always → Inbox); what
  the phone share sheet uses.
- **`POST /api/collections/<id>/items`** `{url}` — the same-origin route the web app
  uses, to target a board by id.

See **[docs/integrations.md](docs/integrations.md)** for `curl` examples, response
shapes, the auth/exposure model, and recipes (shell alias, phone shortcut,
bookmarklet, agents).

## Self-hosting on a Debian LXC (systemd)

> Deploying for real? [**docs/self-hosting.md**](docs/self-hosting.md) covers container
> sizing, cross-host reverse proxies, CLI-agent setup, backups, and a troubleshooting
> table — the things that bite once you're past the quick start.

One command on a fresh Debian LXC (run as root, from the repo root):

```bash
sudo bash scripts/install-lxc.sh
```

It installs Node LTS + apt `chromium`, creates a non-root `boardoss` service user,
installs the app to `/opt/board-oss` with a persistent `DATA_DIR` at
`/var/lib/board-oss`, installs + starts the `board-oss` systemd unit
(`deploy/board-oss.service`), and waits for `/healthz`. Tunables via env:
`APP_DIR`, `DATA_DIR`, `PORT`, `APP_USER`.

- **Run mode:** the service runs `node --import tsx src/server.ts` (no build step; `tsx`
  + `typescript` are runtime deps, so `npm ci --omit=dev` keeps them).
- **`better-sqlite3`** uses its prebuilt binary on glibc Linux / Node LTS (no
  compiler needed). If a from-source build is ever required, `apt-get install -y
  build-essential python3` (commented in the install script).
- **Service management:** `systemctl status|restart board-oss`,
  `journalctl -u board-oss -f`.

### Health check

`GET /healthz` → `200 {"ok":true}` — a **pure liveness probe with no DB check** (so
it never flaps during a SQLite WAL checkpoint and trips a restart loop). Used by the
systemd unit and the container healthcheck.

### Reverse proxy (auth + TLS)

The unit binds `127.0.0.1:8080`. To reach board-oss beyond the box, front it with a
reverse proxy that provides auth + TLS — **Caddy + Authelia**, or a **Tailscale**
tailnet. Don't expose the port directly; v1 has no app-level auth (see above).

**If the proxy runs on a different host**, loopback isn't reachable from it and the
proxy will 502 while `/healthz` passes inside the container. Bind wider and restrict
at the network layer instead:

```bash
systemctl edit board-oss     # [Service]  Environment=HOST=0.0.0.0
systemctl restart board-oss
```

Use a **drop-in**, not an edit to the installed unit file: `scripts/install-lxc.sh`
rewrites `/etc/systemd/system/board-oss.service`, so an in-place change is silently
reverted on the next upgrade.

### Enabling AI (optional)

board-oss runs fully with no AI (enrichment shows a dignified "disabled" state). To
enable analysis, set the provider env on the unit (`Environment=LLM_BASE_URL=…
LLM_API_KEY=… LLM_MODEL=…` or a CLI agent via `LLM_AGENT`) and `systemctl restart
board-oss`.

A **CLI agent** (`LLM_AGENT=claude` / `codex`) has three failure modes that produce no
obvious error. board-oss spawns the agent by bare command name, so:

- **systemd's `PATH` is minimal** and won't find a binary your login shell finds —
  set `Environment=PATH=…` or install a wrapper.
- **Authentication is interactive** and must be done *as the service user* with the
  unit's `HOME` (`/var/lib/board-oss`), or the service can't read the credentials.
- **Running the agent as root doesn't test what the service does** — it inherits a
  different `HOME` and cwd.

[**docs/self-hosting.md**](docs/self-hosting.md) walks through all three with
verification commands.

### Docker

A multi-stage **Debian-slim/glibc** image (not Alpine — `better-sqlite3` + chromium
on musl is an ABI minefield) runs board-oss as a non-root user with chromium baked in.

```bash
docker build -t board-oss .
docker run -d --name board-oss \
  -p 8080:8080 \
  -v board-oss-data:/data \
  board-oss
```

- **Data persists in the `/data` volume** (`DATA_DIR=/data`) — rebuilds/restarts never
  lose data. Mount a host path or named volume.
- **`HOST=0.0.0.0` inside the container** is the one acceptable broad bind: the
  container boundary is the isolation and the published port is what you control. The
  Story 2.4 boot warning still fires by design — **front the published port with a
  reverse proxy** (Caddy+Authelia / Tailscale); don't expose it raw.
- **Chromium** is the apt `chromium` package; capture uses the no-sandbox launch args
  (Story 6.2) so no `--privileged`/`SYS_ADMIN` is needed. `HEALTHCHECK` hits `/healthz`.
- **Enable AI:** pass provider env, e.g. `-e LLM_BASE_URL=… -e LLM_API_KEY=… -e
  LLM_MODEL=…` (or `-e LLM_AGENT=…` for a CLI agent).

CI (`.github/workflows/ci.yml`) runs the unit suite and builds + boots the image,
asserting `/healthz` and a real in-container screenshot capture.

## Portability

Your data is a plain SQLite file plus a `screenshots/` directory under `DATA_DIR` —
copy the directory and walk away. Upgrading the code (a `git pull` / container
rebuild) never touches `DATA_DIR`.

For moving between machines, board-oss exports everything — boards, items, and the
image files — as a single `.tar` you can restore anywhere. In the app: the button in
the bottom-right → **Your data**. Or `GET /api/backup`. It's a plain ustar archive
(`manifest.json` + `screenshots/`), readable with `tar` and without this app, and
restoring is non-destructive: existing boards keep their fields and existing items
are skipped rather than overwritten.

A container snapshot is a *different* backup — it protects the install, the systemd
config and any agent credentials, which the collection export deliberately doesn't
carry. Run both.

## License

[MIT](./LICENSE) © Seanathon
