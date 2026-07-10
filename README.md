# LinkedIn DevOps Role Scanner

A Chrome extension that scans your LinkedIn feed for DevOps job posts, scores them, syncs them to Notion, and uses a local AI model to extract structured data.

---

## Data flow

```mermaid
flowchart TD
    %% ── LinkedIn Layer ──────────────────────────────────────────────────
    LI([LinkedIn Feed / Jobs Search])
    LI -->|MutationObserver on scroll| CL[content.js\nclassifyV2 · score · keyword match]
    CL -->|score above threshold| HL[Highlight post\nscore pill · match counter]
    HL -->|match detected — auto save| SM[sendMessage saveMatch]

    %% ── Save Decision ───────────────────────────────────────────────────
    SM --> BG[background.js\nService Worker]
    BG -->|server URL configured?| SD{Server\nreachable?}

    SD -->|yes| SRV[POST /save\nLocal Server]
    SD -->|no — offline| LC[chrome.storage.local\ndevopsSavedMatches]
    LC --> SQ[(serverSyncQueue\nchrome.storage.local)]
    SRV -->|duplicate by URL| DUP[return duplicate\nlink existing notionPageId]
    SRV -->|accepted| LC2[also save to\nchrome.storage.local]

    SQ -->|SERVER_SYNC_ALARM\nevery 2 min| RT[runServerSyncQueue\nretry POST /save\n2m → 10m → 30m]
    RT -->|success| SC[serverSyncComplete\nmessage to tabs]
    SC -->|content.js| PIL[swap pill\n⚡ Local only → ✅ Synced]

    %% ── Local Server ────────────────────────────────────────────────────
    SRV --> DB[(SQLite\nmatches · ai_cache\nai_requests)]
    SRV --> WS[WebSocket broadcast\nnewMatch event]
    WS -->|all connected clients| WSC[background.js\nWS client\non each device]
    WSC -->|tabs.sendMessage| MOB[matchSavedByOther\n👤 saved by X pill]

    %% ── AI Path ─────────────────────────────────────────────────────────
    LC2 -->|Step 2 auto trigger| AI[sendMessage analyzeWithAI]
    AI --> BG2[background.js]
    BG2 -->|hash dedup check| HC{In\nai_cache?}
    HC -->|yes cached| CAC[return cached analysis\nskipped=true\nlog ai_requests cached=1]
    HC -->|no — enqueue| OL[POST /ai\nLocal Server AI Queue]
    OL -->|POST /api/generate| OLL([Ollama\nlocal model])
    OLL -->|jobTitles · visaSponsorship\nconfidence JSON| OL
    OL --> DB
    OL --> WS2[WebSocket broadcast\naiComplete event]
    OL -->|log model · tokens · ms| DB

    %% ── Notion Path ─────────────────────────────────────────────────────
    LC2 -->|Step 1 auto trigger| NT[sendMessage syncMatchToNotion]
    NT --> BG3[background.js]
    BG3 -->|notionToken set?| NTC{Notion\nconfigured?}
    NTC -->|no| SKP[skip]
    NTC -->|yes| NP[POST api.notion.com\ncreate page]
    NP -->|success| NID[store notionPageId\nPATCH /notion-page-id on server]
    NP -->|fail| NQ[(notionSyncQueue\nchrome.storage.local)]
    NQ -->|NOTION_RETRY_ALARM\nevery 5 min| NR[runNotionRetryQueue\n5m → 15m → 45m → drop]

    AI -->|Step 3 after AI done| NPA[PATCH notion page\nadd AI fields]
    NPA --> NP2[api.notion.com\nPATCH /pages/id]

    %% ── Dedup Layers ─────────────────────────────────────────────────────
    BG -->|layer 1| D1[chrome.storage.local\nURL match · same profile]
    SRV -->|layer 2| D2[SQLite URL UNIQUE\nacross all devices]
    NR -->|layer 3| D3[Notion URL query\nstale check 24h alarm]
    OL -->|layer 4| D4[text_hash in ai_cache\nsame content never re-analyzed]

    %% ── Notion reconcile / push (server-side) ───────────────────────────
    SRV -->|on startup + button| REC[reconcileNotionSync\nbackfill page ids by URL\nclear deleted pages]
    REC -->|query all pages| NP3([api.notion.com])
    SRV -->|dashboard button| PUSH[POST /notion-push-unsynced\nre-link by snippet or create page\nsame properties as extension]
    PUSH --> NP3
    PUSH --> DB

    %% ── Dashboard (light theme, v3) ─────────────────────────────────────
    DB --> DASH[GET /dashboard\nLocal Server]
    DASH --> HDR[Top bar\nsynced · cached · online · uptime]
    DASH --> TOPROW[Total matches · Users\nAI engine model + queue]
    DASH --> CH1[Activity chart\nanalyzed vs saved vs synced\n7d / 14d / 30d tabs]
    DASH --> CH2[AI requests vs cache hits\nline chart]
    DASH --> CH3[Tokens per request +\nresponse time charts\nlast 100 AI runs]
    DASH --> FD[Live feed\nWS events + 200-event replay\nALL / SAVE / AI / ERR filters]
    DASH --> SRC[Saves by source\nfeed · groups · jobs · search]
    DASH --> TOOLS[Notion tools\ndedup · reconcile · push unsynced\nAI role fill · CSV export/import]

    %% ── Multi-device ────────────────────────────────────────────────────
    DEVB([Device B\nPeer User]) -->|POST /save| SRV
    DEVB -->|WS client connects| WS
    DEVA2([Device A\nTab 2 / Tab N]) -->|shared chrome.storage.local| LC
    DEVA2 -->|WS client| WS

    %% ── Styling ─────────────────────────────────────────────────────────
    classDef server fill:#1e293b,stroke:#475569,color:#e2e8f0
    classDef storage fill:#0f172a,stroke:#334155,color:#94a3b8
    classDef external fill:#1e3a5f,stroke:#3b82f6,color:#93c5fd
    classDef decision fill:#2d1b4e,stroke:#7c3aed,color:#c4b5fd
    classDef alert fill:#3b0a0a,stroke:#ef4444,color:#fca5a5
    classDef success fill:#0a2e1a,stroke:#22c55e,color:#86efac

    class SRV,OL,DASH,DB,WS,WS2,REC,PUSH server
    class LC,LC2,SQ,NQ,D1,D2,D3,D4 storage
    class LI,OLL,NP,NP2,NP3,DEVB,DEVA2 external
    class SD,HC,NTC decision
    class DUP,SKP alert
    class NID,SC,PIL,CAC success
```

---

## Installation

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder
5. The extension icon will appear in your toolbar

---

## Features

### Scanning and matching
- Automatically scans LinkedIn feed posts as you scroll
- Uses a two-pass classifier (V2) with sentence-level context, negation detection, and confidence scoring
- Highlights matched posts with a colored border and score pill
- Shows a match counter on each post indicating how many keywords were hit
- Dims posts you have already marked as Applied

### Relevance score
Each matched post gets a score pill (green/yellow/red) based on confidence:
- Considers DevOps keywords, hiring signals, and context
- Hover over the pill to see which signals fired

### Auto-scroll
- Automatically scrolls your LinkedIn feed and scans posts hands-free
- Toggle with the popup switch or keyboard shortcut `Cmd+Shift+S` (Mac) / `Ctrl+Shift+S` (Windows)

### Saved matches
- Save any matched post with one click
- View all saved matches at **Saved Matches** → table with role, experience level, VISA status, keywords, and score
- Mark posts as Applied, Interested, Interviewing, etc.
- Stale posts (404/410) are flagged automatically every 24 hours

### Gmail draft
- One-click button to open a Gmail compose window pre-filled for a job post
- Pulls emails from the post body only (not comments)

### AI re-scan
- Every decorated post has a 🔄 button next to the AI tag
- Forces a fresh AI analysis (bypasses all caches) and re-syncs the existing Notion page, never creating a duplicate

### Diagnostic post capture
- Settings → "Diagnostic Post Capture" records every classified post with its full score trace (`v2signals`)
- Written to `server/diagnostics/posts.jsonl` when a server is configured, plus a 150-record ring buffer in chrome.storage
- Used to debug misclassifications; turn it off when done

---

## Local server (optional)

A small Express server (`server/server.js`, port 3747) coordinates multiple devices: SQLite dedup across users, a shared AI queue, WebSocket push of new matches, and a web dashboard.

```bash
cd server
npm install
NOTION_TOKEN=secret_... NOTION_DB_ID=... node server.js
```

The Notion env vars are optional but enable the server-side Notion tools (reconcile, push unsynced, dedup, AI role fill, CSV export/import). Point the extension at the server via Settings → Server URL. Offline saves queue in the extension and retry every 2 minutes.

### Dashboard

`http://localhost:3747/dashboard` — light-theme dashboard, live over WebSocket (new connections replay the last 200 events):

- **Top bar**: synced / cached / online counts and server uptime
- **Top row**: total matches, users with per-user unsynced badges, AI engine status (queue, cache, model)
- **Left**: live feed with ALL / SAVE / AI / ERR filters, and saves by source (home feed, groups, jobs, search; quiet sources flagged after 14 days)
- **Right**: four charts — activity (analyzed / saved / Notion synced, 7d/14d/30d), AI requests vs cache hits, and per-request tokens and response time for the last 100 AI runs
- **Bottom**: Notion tools — duplicate cleanup, sync reconcile, push unsynced (creates or re-links pages server-side for rows that never reached Notion), AI role fill via Ollama, CSV export/import

### Server endpoints

| Endpoint | Purpose |
|---|---|
| `POST /save` | Save a match (atomic dedup by URL) |
| `GET /stats`, `GET /chart-data` | Dashboard data |
| `POST /ai`, `GET /ai/:hash` | Shared AI queue with hash dedup |
| `POST /notion-reconcile` | Re-derive Notion page ids from Notion (also runs at startup) |
| `POST /notion-push-unsynced` | Create or re-link Notion pages for unsynced rows |
| `POST /notion-dedup` | Find/archive duplicate Notion pages by URL |
| `POST /notion-fill-ai` | Backfill AI fields on Notion pages via Ollama |
| `GET /notion-export`, `POST /notion-import` | CSV round-trip |
| `GET /diag`, `POST /diag` | Diagnostic post capture |

---

## Notion setup

Notion sync saves every matched post to a Notion database and keeps it updated.

### 1. Create a Notion integration
1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**, give it a name, select your workspace
3. Copy the **Internal Integration Token** (starts with `secret_...`)

### 2. Create a database
Create a Notion database with these properties (exact names and types):

| Property | Type |
|---|---|
| Name | Title |
| Keywords | Text |
| Score | Number |
| Status | Status |
| Emails | Text |
| Date | Date |
| Snippet | Text |
| URL | URL |
| Job Title | Text |
| Experience Level | Text |
| VISA | Text |
| AI Confidence | Number |

### 3. Share the database with your integration
- Open the database in Notion
- Click **...** menu → **Add connections** → select your integration

### 4. Get the database ID
The database ID is in the URL:
```
https://www.notion.so/yourworkspace/THIS-IS-THE-DATABASE-ID?v=...
```
Copy the 32-character ID (with or without hyphens).

### 5. Save credentials in extension settings
- Open the extension popup → **Settings**
- Scroll to **Notion** section
- Paste your token and database ID → **Save**
- Click **Test Connection** to verify

Once configured, every new saved match syncs to Notion automatically. Use **Test Sync** in the popup to verify the connection at any time.

---

## Local AI setup (Ollama)

The extension uses a local AI model via [Ollama](https://ollama.com) to extract structured fields from post text:
- Job Title: the exact role being hired for
- Experience Level: junior / mid / senior / lead / any
- VISA Sponsorship: e.g. "H1B sponsored", "No H1B", "GC/Citizen only", "OPT/CPT accepted"
- AI Confidence: a 0-100 score

### 1. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Or download the Mac app from [ollama.com](https://ollama.com).

### 2. Pull a model

Recommended (lightweight, good JSON extraction):
```bash
ollama pull qwen2.5:3b
```

Smaller option if resources are tight:
```bash
ollama pull qwen2.5:0.5b
```

### 3. Start Ollama with Chrome extension access

Chrome extensions are blocked by Ollama's CORS policy by default. Start it with:

```bash
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

To stop any running Ollama instance first:
```bash
pkill ollama
# or if the port is stuck:
kill -9 $(lsof -ti:11434)
```

If you use the Ollama Mac menu bar app, quit it from the menu bar icon before running the command above.

### 4. Configure in extension settings
- Open the extension popup → **Settings**
- Scroll to **Ollama** section
- Set **URL**: `http://localhost:11434`
- Set **Model**: `qwen2.5:3b` (or whichever model you pulled)
- Click **Test Connection** to verify

### 5. Processing matches

**New matches** are analyzed automatically after being saved.

**Existing / backfill**: Click **Process Unanalyzed** in Settings. This will:
1. Fetch all pages from your Notion database
2. Find any match missing AI fields (`jobTitle`, `experienceLevel`, `visaSponsorship`)
3. Run them through Ollama and PATCH the results back to Notion

You can stop mid-run with the **Stop** button and resume later.

AI scan progress is shown in the popup widget (e.g. `🤖 AI Scanned 12 / 34`).

---

## Settings reference

| Setting | Description |
|---|---|
| Ollama URL | Base URL of your Ollama instance (default: `http://localhost:11434`) |
| Ollama Model | Model name to use for analysis (e.g. `qwen2.5:3b`) |
| Notion Token | Your Notion integration token (`secret_...`) |
| Notion Database ID | ID of the target Notion database |

---

## Troubleshooting

**Extension not scanning posts**
- Make sure you are on `linkedin.com/feed` or a LinkedIn search page
- Refresh the page after installing or updating the extension

**Notion sync failing with 401**
- Your token is invalid or expired. Regenerate it at notion.so/my-integrations and re-save in Settings

**Notion sync failing with 400**
- Check that all database property names and types match the table above exactly

**Ollama returning 403**
- You must start Ollama with `OLLAMA_ORIGINS="chrome-extension://*"`; a plain `ollama serve` will be blocked

**Ollama returning 500**
- The model may not be pulled yet — run `ollama pull <model-name>`
- If Ollama was installed via Homebrew and broke: `brew uninstall ollama && curl -fsSL https://ollama.com/install.sh | sh`

**Port 11434 already in use**
```bash
kill -9 $(lsof -ti:11434)
```
