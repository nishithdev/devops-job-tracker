# LinkedIn DevOps Role Scanner

A Chrome extension that scans your LinkedIn feed for DevOps job posts, scores them, syncs them to Notion, and uses a local AI model to extract structured data.

---

## Data Flow

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

    %% ── Dashboard ───────────────────────────────────────────────────────
    DB --> DASH[GET /dashboard\nLocal Server]
    DASH --> CH1[Chart: saves vs analyzed\n14 day bar chart]
    DASH --> CH2[Chart: AI requests vs cache hits\n14 day line chart]
    DASH --> UL[Users panel\nsaved_by counts]
    DASH --> FD[Live feed\nWS events]

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

    class SRV,OL,DASH,DB,WS,WS2 server
    class LC,LC2,SQ,NQ,D1,D2,D3,D4 storage
    class LI,OLL,NP,NP2,DEVB,DEVA2 external
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

### Scanning & Matching
- Automatically scans LinkedIn feed posts as you scroll
- Uses a two-pass classifier (V2) with sentence-level context, negation detection, and confidence scoring
- Highlights matched posts with a colored border and score pill
- Shows a match counter on each post indicating how many keywords were hit
- Dims posts you have already marked as Applied

### Relevance Score
Each matched post gets a score pill (green/yellow/red) based on confidence:
- Considers DevOps keywords, hiring signals, and context
- Hover over the pill to see which signals fired

### Auto-Scroll
- Automatically scrolls your LinkedIn feed and scans posts hands-free
- Toggle with the popup switch or keyboard shortcut `Cmd+Shift+S` (Mac) / `Ctrl+Shift+S` (Windows)

### Saved Matches
- Save any matched post with one click
- View all saved matches at **Saved Matches** → table with role, experience level, VISA status, keywords, and score
- Mark posts as Applied, Interested, Interviewing, etc.
- Stale posts (404/410) are flagged automatically every 24 hours

### Gmail Draft
- One-click button to open a Gmail compose window pre-filled for a job post
- Emails are extracted from the post body only (not comments)

---

## Notion Setup

Notion sync saves every matched post to a Notion database and keeps it updated.

### 1. Create a Notion Integration
1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**, give it a name, select your workspace
3. Copy the **Internal Integration Token** (starts with `secret_...`)

### 2. Create a Database
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

### 3. Share the Database with Your Integration
- Open the database in Notion
- Click **...** menu → **Add connections** → select your integration

### 4. Get the Database ID
The database ID is in the URL:
```
https://www.notion.so/yourworkspace/THIS-IS-THE-DATABASE-ID?v=...
```
Copy the 32-character ID (with or without hyphens).

### 5. Save Credentials in Extension Settings
- Open the extension popup → **Settings**
- Scroll to **Notion** section
- Paste your token and database ID → **Save**
- Click **Test Connection** to verify

Once configured, every new saved match syncs to Notion automatically. Use **Test Sync** in the popup to verify the connection at any time.

---

## Local AI Setup (Ollama)

The extension uses a local AI model via [Ollama](https://ollama.com) to extract structured fields from post text:
- **Job Title** — the exact role being hired for
- **Experience Level** — junior / mid / senior / lead / any
- **VISA Sponsorship** — e.g. "H1B sponsored", "No H1B", "GC/Citizen only", "OPT/CPT accepted"
- **AI Confidence** — 0–100 score

### 1. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Or download the Mac app from [ollama.com](https://ollama.com).

### 2. Pull a Model

Recommended (lightweight, good JSON extraction):
```bash
ollama pull qwen2.5:3b
```

Smaller option if resources are tight:
```bash
ollama pull qwen2.5:0.5b
```

### 3. Start Ollama with Chrome Extension Access

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

### 4. Configure in Extension Settings
- Open the extension popup → **Settings**
- Scroll to **Ollama** section
- Set **URL**: `http://localhost:11434`
- Set **Model**: `qwen2.5:3b` (or whichever model you pulled)
- Click **Test Connection** to verify

### 5. Processing Matches

**New matches** are analyzed automatically after being saved.

**Existing / backfill**: Click **Process Unanalyzed** in Settings. This will:
1. Fetch all pages from your Notion database
2. Find any match missing AI fields (`jobTitle`, `experienceLevel`, `visaSponsorship`)
3. Run them through Ollama and PATCH the results back to Notion

You can stop mid-run with the **Stop** button and resume later.

AI scan progress is shown in the popup widget (e.g. `🤖 AI Scanned 12 / 34`).

---

## Settings Reference

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
- Your token is invalid or expired — regenerate it at notion.so/my-integrations and re-save in Settings

**Notion sync failing with 400**
- Check that all database property names and types match the table above exactly

**Ollama returning 403**
- Ollama must be started with `OLLAMA_ORIGINS="chrome-extension://*"` — a plain `ollama serve` will be blocked

**Ollama returning 500**
- The model may not be pulled yet — run `ollama pull <model-name>`
- If Ollama was installed via Homebrew and broke: `brew uninstall ollama && curl -fsSL https://ollama.com/install.sh | sh`

**Port 11434 already in use**
```bash
kill -9 $(lsof -ti:11434)
```
