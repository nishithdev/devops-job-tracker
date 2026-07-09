#!/usr/bin/env node
/**
 * notion-dedup.js: find and remove duplicate Notion DB entries by URL.
 *
 * Usage:
 *   NOTION_TOKEN=secret_xxx NOTION_DB_ID=yyy node scripts/notion-dedup.js [--dry-run]
 *
 * Keeps the oldest page (first created) per URL; archives the rest.
 * --dry-run prints what would be removed without making changes.
 */

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;
const DRY_RUN = process.argv.includes('--dry-run');

if (!TOKEN || !DB_ID) {
  console.error('Set NOTION_TOKEN and NOTION_DB_ID env vars.');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

async function fetchAllPages() {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Query failed ${res.status}: ${t}`);
    }
    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

function getUrl(page) {
  return page.properties?.URL?.url || null;
}

async function archivePage(id) {
  const res = await fetch(`https://api.notion.com/v1/pages/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ archived: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Archive ${id} failed ${res.status}: ${t}`);
  }
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('Fetching all pages...');
  const pages = await fetchAllPages();
  console.log(`Total pages: ${pages.length}`);

  // Group by URL
  const byUrl = new Map();
  const noUrl = [];
  for (const p of pages) {
    const url = getUrl(p);
    if (!url) { noUrl.push(p); continue; }
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(p);
  }

  // Find duplicates
  const dupes = [];
  for (const [url, group] of byUrl) {
    if (group.length < 2) continue;
    // Sort oldest first (keep first, archive rest)
    group.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
    const keep = group[0];
    const remove = group.slice(1);
    dupes.push({ url, keep, remove });
  }

  if (dupes.length === 0) {
    console.log('No duplicates found.');
    return;
  }

  console.log(`\nFound ${dupes.length} URLs with duplicates:`);
  let totalRemoved = 0;
  for (const { url, keep, remove } of dupes) {
    console.log(`\n  URL: ${url}`);
    console.log(`  Keep:   ${keep.id} (created ${keep.created_time})`);
    for (const p of remove) {
      console.log(`  Remove: ${p.id} (created ${p.created_time})`);
      if (!DRY_RUN) {
        await archivePage(p.id);
        console.log(`          -> archived`);
      }
      totalRemoved++;
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] Would remove' : 'Removed'}: ${totalRemoved} duplicate pages`);
  if (noUrl.length) console.log(`Pages with no URL (skipped): ${noUrl.length}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
