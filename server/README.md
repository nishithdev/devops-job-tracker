# DevOps Scanner — Local Server

Optional coordination server for multi-user setups. When running, it provides:

- **Atomic dedup** — one Notion row per LinkedIn post URL, regardless of how many users scan it simultaneously
- **Shared AI queue** — one Ollama request per unique post; results cached across all users
- **Real-time badges** — when User A saves a post, User B sees "👤 saved by A" on that post within ~100ms
- **SQLite persistence** — match history survives extension restarts; `notionPageId` shared across devices

Without the server, each extension works independently (original behavior). The server is purely additive.

---

## Requirements

- Node.js ≥ 18 (tested on v20+)
- Ollama running on the same machine (default `http://localhost:11434`)
- All users on the same local network

---

## Install & run

```bash
# 1. Go to server directory
cd server

# 2. Install dependencies (first time only)
npm install

# 3. Start the server
npm start
```

You should see:
```
[DevOps Scanner] Server listening on port 3747
[DevOps Scanner] DB: .../server/scanner.db
[DevOps Scanner] Health: http://localhost:3747/health
```

Open the dashboard in your browser: `http://localhost:3747/dashboard`

Server binds to `0.0.0.0:3747`. Find your machine's local IP for other users on the network:

```bash
# macOS / Linux
ipconfig getifaddr en0      # Wi-Fi
ipconfig getifaddr en1      # Ethernet

# Windows
ipconfig | findstr "IPv4"
```

---

## Extension configuration

1. Open the extension → **Settings** → **Local Server** section
2. Enter `http://192.168.x.x:3747` (your server machine's IP)
3. Click **Test Connection** — should show match count and active clients
4. Click **Save**

Each user on the team does this once. The extension falls back to local-only mode automatically if the server is unreachable.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3747` | Port to listen on |
| `DB_PATH` | `server/scanner.db` | SQLite database file path |

```bash
PORT=4000 DB_PATH=/data/scanner.db node server.js
```

---

## API reference

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/save` | `{ match, userName }` | Atomic save + dedup. Returns `{ saved, matchId }` or `{ duplicate, notionPageId }` |
| `POST` | `/ai` | `{ text, hash, ollamaUrl?, ollamaModel? }` | Shared AI analysis. Cached by `hash`. |
| `PATCH` | `/notion-page-id` | `{ url, matchId, notionPageId }` | Store Notion page ID after extension sync |
| `PATCH` | `/status` | `{ url?, matchId?, status }` | Update match status in local DB |
| `GET` | `/matches` | — | Recent matches (`?limit=200`, max 500) |
| `GET` | `/health` | — | `{ ok, matches, aiCacheSize, wsClients }` |
| `GET` | `/stats` | — | Detailed stats + recent matches + per-user counts |
| `GET` | `/dashboard` | — | Real-time web dashboard (browser) |
| `WS` | `/ws` | — | Receives `{ action: "newMatch"/"aiStart"/"aiComplete"/"aiError" }` push events |

---

## How dedup works

```
User A scans post X
  → POST /save { url: "linkedin.com/..." }
  → Server: URL not in DB → INSERT → broadcast newMatch → { saved: true }
  → User A's extension: save locally, sync to Notion, PATCH /notion-page-id with Notion page ID

User B scans same post X (any time after)
  → POST /save { url: "linkedin.com/..." }
  → Server: URL already in DB → { duplicate: true, notionPageId: "abc..." }
  → User B's extension: skip local save, link notionPageId locally, skip Notion POST
  → User B sees "👤 saved by A" badge on the post (via WebSocket push)
```

Race condition (A and B scan simultaneously before either response returns):
- Both POST /save → SQLite `INSERT OR IGNORE` on `url UNIQUE` → one succeeds, one is silently ignored
- The 24-hour alarm also deduplicates Notion rows and rebuilds the `notionPageId` cache

---

## Data stored

**`matches` table**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Match ID from extension |
| `url` | TEXT UNIQUE | LinkedIn post URL |
| `notion_page_id` | TEXT | Set after Notion sync |
| `saved_by` | TEXT | User's display name |
| `data` | TEXT | Full match JSON |
| `created_at` | INTEGER | Unix ms |
| `updated_at` | INTEGER | Unix ms |

**`ai_cache` table**

| Column | Type | Notes |
|---|---|---|
| `text_hash` | TEXT | djb2 hash of post text |
| `analysis` | TEXT | `{ jobTitles, visaSponsorship, confidence }` JSON |
| `model` | TEXT | Ollama model used |
| `time_ms` | INTEGER | Processing time |
| `tokens` | INTEGER | Prompt + eval tokens |
| `created_at` | INTEGER | Unix ms |

---

## Running as a background service

**macOS (launchd)**

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
```

**Linux (systemd)**

```ini
[Unit]
Description=DevOps Scanner Server
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/devops-job-tracker/server/server.js
Restart=always
User=youruser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable devops-scanner && sudo systemctl start devops-scanner
```

**Windows**

Use [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start server.js --name devops-scanner
pm2 save
pm2 startup
```
