# DevOps Scanner — Local Server

Optional coordination server for multi-user / multi-machine setups. When running, it provides:

- **Atomic dedup** — one Notion row per LinkedIn post URL regardless of how many users scan simultaneously
- **Shared AI queue** — one Ollama request per unique post; results cached across all users
- **Real-time badges** — when User A saves a post, User B sees "👤 saved by A" within ~100ms
- **SQLite persistence** — match history survives extension restarts; `notionPageId` shared across devices
- **Peer federation** — two servers on different machines sync automatically; each works offline independently

Without the server, each extension works standalone (original behavior). The server is purely additive.

---

## Requirements

- Node.js ≥ 18 (tested on v20+)
- Ollama running on the same machine (default `http://localhost:11434`)
- Machines on the same local network (for peer sync)

---

## Single machine setup

```bash
cd server
npm install
npm start
```

Output:
```
[DevOps Scanner] Server listening on port 3747
[DevOps Scanner] DB: .../server/scanner.db
[DevOps Scanner] Health: http://localhost:3747/health
```

Open dashboard: `http://localhost:3747/dashboard`

**Extension config:** Settings → Local Server → enter `http://localhost:3747` → Save.

---

## Multi-machine setup (peer federation)

This is the setup for running a server on both Mac and Ubuntu so each works independently when the other is offline, and syncs when both are up.

### Architecture

```
Mac (192.168.1.10)                Ubuntu (192.168.1.20)
┌─────────────────────┐           ┌─────────────────────┐
│  server.js          │◄─── sync ─►│  server.js          │
│  scanner.db (local) │           │  scanner.db (local) │
│  Ollama (local)     │           │  Ollama (local)     │
└────────┬────────────┘           └──────────┬──────────┘
         │ localhost:3747                     │ localhost:3747
    Mac extension                      Ubuntu extension
```

Each machine runs its own server. Each extension points to `localhost`. When both servers are online they stay in sync. When one goes offline, the other keeps working. When it comes back, it pulls the gap automatically on startup.

### There is no primary/secondary

Both servers are equal peers. Neither is authoritative. Whichever machine is online handles requests for the extension running on it. When both are online, a save on Mac immediately forwards to Ubuntu and vice versa. The `PEERS` env var just tells each server where to push updates.

### Step 1 — Find each machine's LAN IP

```bash
# macOS
ipconfig getifaddr en0      # Wi-Fi
ipconfig getifaddr en1      # Ethernet

# Linux
hostname -I | awk '{print $1}'
```

### Step 2 — Start each server with the other's IP as a peer

**Mac** (knows about Ubuntu):
```bash
PEERS=http://192.168.1.20:3747 node server.js
```

**Ubuntu** (knows about Mac):
```bash
PEERS=http://192.168.1.10:3747 node server.js
```

Each server will:
1. On startup — pull all matches from the peer it doesn't have yet
2. On every `/save` — forward the match to all peers (non-blocking)
3. On every Notion sync — forward the `notionPageId` to peers so the other machine doesn't re-sync

### Step 3 — Extension config (each machine)

Both extensions point to `http://localhost:3747`. No cross-machine URLs needed in the extension.

### Step 4 — Verify sync is working

Open the dashboard on both machines (`http://localhost:3747/dashboard`). The header shows:

```
peers: 1/1   ← green = peer reachable
peers: 0/1   ← red = peer offline
```

When Mac comes back online after being off, restart its server — it will pull the gap from Ubuntu automatically. You'll see in the logs:
```
[peer] syncing from 1 peer(s): http://192.168.1.20:3747
[peer] synced 12 new matches from http://192.168.1.20:3747
```

---

## How to tell which server handled a save

Check the dashboard **Live Activity** feed — the `SAVE` entry shows `saved by <username>` where username is whatever name the extension user configured. Since each machine has its own user, you can see which machine originated the save.

The `saved_by` column in SQLite also records this permanently:
```bash
sqlite3 scanner.db "SELECT saved_by, COUNT(*) FROM matches GROUP BY saved_by;"
```

---

## Monitoring the connection

### Dashboard (browser)
`http://localhost:3747/dashboard` — live feed, peer status in header, Ollama status, queue depth.

### Health endpoint
```bash
curl http://localhost:3747/health
# {"ok":true,"matches":47,"aiCacheSize":12,"wsClients":1,"peers":1}
```

### Check if peer is reachable from your machine
```bash
curl http://192.168.1.20:3747/health
```

### Watch sync logs
If running with `npm start`, add `DEBUG=peer` or just tail the process output. Each peer operation logs to stdout.

### Manual sync trigger (if peer was offline and you don't want to restart)
There's no manual trigger endpoint yet — restart the server to re-run startup sync, or wait for the next save event to forward automatically.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3747` | Port to listen on |
| `DB_PATH` | `server/scanner.db` | SQLite database file path |
| `PEERS` | _(none)_ | Comma-separated peer server URLs |

```bash
PORT=3747 PEERS=http://192.168.1.20:3747 DB_PATH=/data/scanner.db node server.js
```

Multiple peers (if you ever add a third machine):
```bash
PEERS=http://192.168.1.20:3747,http://192.168.1.30:3747 node server.js
```

---

## Running as a background service

### macOS (launchd) — recommended for Mac

Create `~/Library/LaunchAgents/com.devops-scanner.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.devops-scanner.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/devops-job-tracker/server/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PEERS</key>
    <string>http://192.168.1.20:3747</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/devops-scanner.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/devops-scanner.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.devops-scanner.server.plist

# Check status
launchctl list | grep devops-scanner

# View logs
tail -f /tmp/devops-scanner.log

# Restart
launchctl unload ~/Library/LaunchAgents/com.devops-scanner.server.plist
launchctl load ~/Library/LaunchAgents/com.devops-scanner.server.plist
```

### Linux (systemd) — recommended for Ubuntu

Create `/etc/systemd/system/devops-scanner.service`:

```ini
[Unit]
Description=DevOps Scanner Server
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/devops-job-tracker/server/server.js
Restart=always
RestartSec=5
User=youruser
Environment=PEERS=http://192.168.1.10:3747

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable devops-scanner
sudo systemctl start devops-scanner

# Check status
sudo systemctl status devops-scanner

# View logs
journalctl -u devops-scanner -f

# Restart
sudo systemctl restart devops-scanner
```

---

## How sync works

### On save (real-time)
```
Ubuntu extension saves a post
  → POST localhost:3747/save
  → Ubuntu server: INSERT into local DB → respond to extension
  → Ubuntu server: async POST http://192.168.1.10:3747/save { fromPeer: true }
  → Mac server: INSERT into local DB (if not already there)
```
`fromPeer: true` stops the Mac from re-forwarding back to Ubuntu (no loop).

### On startup (gap fill)
```
Mac server starts
  → GET http://192.168.1.20:3747/sync?since=<last_updated_at>
  → Ubuntu returns all rows newer than that timestamp
  → Mac inserts any missing rows
```

### Notion page IDs
When Mac's extension syncs a match to Notion, it PATCHes `/notion-page-id` on Mac's server. Mac forwards that to Ubuntu's server. This prevents Ubuntu's extension from creating a duplicate Notion page for the same match.

### What doesn't sync
- AI cache — each machine builds its own independently (Ollama is local per machine)
- Extension settings — these live in Chrome storage, never touch the server

---

## API reference

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/save` | `{ match, userName, fromPeer? }` | Atomic save + dedup. Forwards to peers unless `fromPeer: true` |
| `POST` | `/ai` | `{ text, hash, ollamaUrl?, ollamaModel? }` | Shared AI analysis, cached by hash |
| `PATCH` | `/notion-page-id` | `{ url, matchId, notionPageId, fromPeer? }` | Store Notion page ID, forwarded to peers |
| `PATCH` | `/status` | `{ url?, matchId?, status }` | Update match status |
| `GET` | `/matches` | — | Recent matches (`?limit=200`, max 500) |
| `GET` | `/sync` | — | Peer sync: rows updated since `?since=<ms>` |
| `GET` | `/health` | — | `{ ok, matches, aiCacheSize, wsClients, peers }` |
| `GET` | `/stats` | — | Full stats including peer list |
| `GET` | `/ollama-status` | — | Ollama reachability + available models |
| `GET` | `/dashboard` | — | Real-time web dashboard |
| `WS` | `/ws` | — | Push events: `newMatch` / `aiStart` / `aiComplete` / `aiError` |

---

## Troubleshooting

**Peer shows `0/1` in dashboard**
- Check the other machine is running: `curl http://192.168.1.XX:3747/health`
- Check firewall: `sudo ufw allow 3747` on Ubuntu
- Make sure the IP hasn't changed (DHCP can rotate IPs — set static LAN IPs or use hostnames)

**Matches not syncing after Mac comes back online**
- Restart Mac's server — startup sync runs on boot and pulls the gap
- Or manually check: `curl "http://192.168.1.10:3747/sync?since=0"` to see what Mac has

**Duplicate Notion pages**
- This means `notion-page-id` didn't forward before the other machine's extension tried to sync
- Fix: run the extension's "retry queue" or check both servers have the same `notion_page_id` for that URL:
  ```bash
  sqlite3 scanner.db "SELECT url, notion_page_id FROM matches WHERE url LIKE '%linkedin%' ORDER BY created_at DESC LIMIT 5;"
  ```

**Static LAN IPs (recommended)**
Dynamic IPs break peer config. Set static IPs in your router's DHCP reservation by MAC address, or on each machine:

- **macOS:** System Settings → Network → Details → TCP/IP → Configure IPv4: Manually
- **Ubuntu:** `sudo nano /etc/netplan/01-netcfg.yaml` → set static address
