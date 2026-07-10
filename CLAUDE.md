# CLAUDE.md

Chrome extension (Manifest v3) that scans LinkedIn feed/search/jobs pages for DevOps role posts, highlights matches, and saves them (chrome.storage + optional local server + Notion sync).

## Layout

- `content.js` — content script; scan loop, `classifyV2()` scoring, decoration, save flow
- `background.js` — service worker; message router (`chrome.runtime.onMessage`), AI analysis, Notion sync, server sync queue
- `shared/` — utilities loaded before content.js (`getPostUrl` in `postHelpers.js`, storage wrappers in `storageUtils.js`, keyword defaults in `keywordConfig.js`)
- `server/server.js` — optional local Express server (port 3747); SQLite dedup, shared AI queue, WebSocket push

## Keywords — code is source of truth

Default keyword lists live in `shared/keywordConfig.js` (`DEFAULT_DEVOPS_KEYWORDS`, `DEFAULT_HIRING_SIGNALS`, `DEFAULT_INVALID_KEYWORDS`). Edit them there — they always reach the runtime. Storage key `customKeywords` holds only user deltas: `{ added: {category: []}, disabled: {category: []} }`. Effective list = `resolveKeywords()` = (defaults ∪ added) − disabled. Legacy full-snapshot storage (pre-delta installs) is auto-migrated: stored arrays are treated as additions beyond defaults, so a stale snapshot can never shadow keywords added to code later. Settings-UI "×" on a default keyword disables it (only code edits remove defaults); "×" on a user-added keyword deletes it. After a code edit, reload the extension (content script reads keywords at inject + on `reloadKeywords` message).
- `settings.html/js`, `diagnostics.html/js`, `popup.html/js`, `saved.html/js` — extension pages

## AI re-scan button

Decorated posts have a 🔄 button next to the AI tag: re-runs AI analysis with `force: true` and re-syncs to Notion (PATCHes the existing page via `notionPageId`, never duplicates). Force propagates through `rescanAIForPost` (content.js) → `handleAnalyzeWithAI` (background.js, skips local `aiTextHash` cache) → `POST /ai` with `force` (server evicts `aiCache` + `ai_cache` DB row before queueing).

## Diagnostic post capture (debugging misclassifications)

When a post is wrongly matched/skipped, use the capture pipeline to get the exact text and score breakdown the classifier saw:

1. **Enable**: Settings page → "🔬 Diagnostic Post Capture" checkbox (storage key `diagCaptureEnabled`). Off by default — post text is stored in plain text.
2. **Reproduce**: user scrolls LinkedIn past the problem post. Every classified post (feed + job cards) is captured.
3. **Read the data** (two places):
   - **Server file (preferred)**: `server/diagnostics/posts.jsonl` — one JSON record per line, append-only, gitignored. Grep it directly, or `curl http://localhost:3747/diag?limit=50`. Only written when a local server URL is configured in settings.
   - **Storage fallback**: last 150 records in chrome.storage key `devopsDiagPosts`; user exports via Diagnostics page → "Export Captured Posts" button and shares the JSON file.

### Record shape

```json
{
  "time": "ISO timestamp",
  "source": "feed | jobs",
  "pageUrl": "...", "postUrl": "linkedin activity URL or null",
  "decision": "match | skip",
  "confidence": 0-100,
  "devopsHits": ["keyword", ...],
  "hiringHits": ["signal", ...],
  "invalidHit": "keyword or null",
  "v2signals": ["\"aws\" [hiring] +14", "negated \"devops\" (-3)", ...],
  "textLen": 123,
  "text": "full post text as the scanner saw it"
}
```

### How to diagnose

- `v2signals` is the full score trace from `classifyV2()` (content.js) — every keyword hit with its context bucket, negation penalties, structural bonuses (email, salary, bullets, apply-instruction). Match rule: ≥1 devops keyword AND confidence ≥ 40.
- To replay: run the record's `text` through the scoring logic in `classifyV2()`; keyword lists come from `shared/keywordConfig.js` unless the user has custom/disabled keywords (storage key `customKeywords`).
- A post appearing multiple times is normal — it is re-captured when its text grows ("see more" expansion). Compare `textLen`.
- Pipeline wiring: content.js `captureDiag()` → background.js `handleDiagCapture` (`diagCapture` message) → `POST /diag` on server + `devopsDiagPosts` ring buffer.
- Remind user to turn the toggle off when done; the JSONL file grows unbounded (safe to delete).
