#!/usr/bin/env node
/**
 * notion-import.js: patch a processed CSV back into Notion pages.
 *
 * Usage:
 *   NOTION_TOKEN=secret_xxx node scripts/notion-import.js --in=jobs.csv [--dry-run]
 *
 * Expects a `page_id` column (as produced by notion-export.js) to match
 * each row back to its Notion page. Reads the database schema to know how
 * to format each property type. Read-only/complex types (people,
 * created_time, last_edited_time) are skipped if present as columns.
 */

const TOKEN = process.env.NOTION_TOKEN;
const IN = (process.argv.find(a => a.startsWith('--in=')) || '').split('=')[1];
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_TYPES = new Set(['people', 'created_time', 'last_edited_time', 'formula', 'rollup']);

if (!TOKEN || !IN) {
  console.error('Set NOTION_TOKEN env var and pass --in=file.csv');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function getPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers });
  if (!res.ok) throw new Error(`Fetch page ${pageId} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildPropertyValue(type, rawValue) {
  switch (type) {
    case 'title':
      return { title: [{ type: 'text', text: { content: rawValue } }] };
    case 'rich_text':
      return { rich_text: [{ type: 'text', text: { content: rawValue } }] };
    case 'select':
      return { select: rawValue ? { name: rawValue } : null };
    case 'status':
      return { status: rawValue ? { name: rawValue } : null };
    case 'multi_select':
      return { multi_select: rawValue ? rawValue.split(';').map(s => ({ name: s.trim() })).filter(s => s.name) : [] };
    case 'date': {
      if (!rawValue) return { date: null };
      const [start, end] = rawValue.split('->').map(s => s.trim());
      return { date: { start, end: end || null } };
    }
    case 'url':
      return { url: rawValue || null };
    case 'email':
      return { email: rawValue || null };
    case 'phone_number':
      return { phone_number: rawValue || null };
    case 'number':
      return { number: rawValue === '' ? null : Number(rawValue) };
    case 'checkbox':
      return { checkbox: rawValue === 'true' };
    default:
      return null;
  }
}

async function patchPage(pageId, properties) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Patch ${pageId} failed ${res.status}: ${await res.text()}`);
}

async function main() {
  const fs = await import('node:fs');
  const text = fs.readFileSync(IN, 'utf8');
  const rows = parseCsv(text);
  if (rows.length === 0) { console.log('No rows in CSV.'); return; }
  if (!('page_id' in rows[0])) { console.error('CSV missing page_id column.'); process.exit(1); }

  const columns = Object.keys(rows[0]).filter(c => c !== 'page_id');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Rows: ${rows.length}, columns to patch: ${columns.join(', ')}`);

  let updated = 0, skipped = 0;
  for (const row of rows) {
    const pageId = row.page_id;
    if (!pageId) { skipped++; continue; }

    const page = await getPage(pageId);
    const properties = {};
    for (const col of columns) {
      const existing = page.properties[col];
      if (!existing) continue;
      if (SKIP_TYPES.has(existing.type)) continue;
      const value = buildPropertyValue(existing.type, row[col]);
      if (value) properties[col] = value;
    }

    if (Object.keys(properties).length === 0) { skipped++; continue; }

    console.log(`  ${pageId}: ${Object.keys(properties).join(', ')}`);
    if (!DRY_RUN) await patchPage(pageId, properties);
    updated++;
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'}: ${updated} pages, skipped: ${skipped}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
