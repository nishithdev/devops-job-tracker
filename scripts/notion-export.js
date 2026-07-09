#!/usr/bin/env node
/**
 * notion-export.js: export a Notion database to CSV for downstream processing.
 *
 * Usage:
 *   NOTION_TOKEN=secret_xxx NOTION_DB_ID=yyy node scripts/notion-export.js [--out=jobs.csv]
 *
 * Includes a `page_id` column so rows can be matched back to Notion pages
 * via notion-import.js after processing.
 */

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;
const OUT = (process.argv.find(a => a.startsWith('--out=')) || '--out=notion-export.csv').split('=')[1];

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

function flattenValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return prop.title.map(t => t.plain_text).join('');
    case 'rich_text':
      return prop.rich_text.map(t => t.plain_text).join('');
    case 'select':
      return prop.select?.name || '';
    case 'status':
      return prop.status?.name || '';
    case 'multi_select':
      return prop.multi_select.map(s => s.name).join('; ');
    case 'date':
      return prop.date ? (prop.date.end ? `${prop.date.start} -> ${prop.date.end}` : prop.date.start) : '';
    case 'url':
      return prop.url || '';
    case 'email':
      return prop.email || '';
    case 'phone_number':
      return prop.phone_number || '';
    case 'number':
      return prop.number ?? '';
    case 'checkbox':
      return prop.checkbox ? 'true' : 'false';
    case 'people':
      return prop.people.map(p => p.name || p.id).join('; ');
    case 'created_time':
      return prop.created_time || '';
    case 'last_edited_time':
      return prop.last_edited_time || '';
    default:
      return '';
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(pages) {
  if (pages.length === 0) return '';
  const columns = Object.keys(pages[0].properties);
  const header = ['page_id', ...columns];
  const lines = [header.join(',')];
  for (const page of pages) {
    const row = [page.id, ...columns.map(col => csvEscape(flattenValue(page.properties[col])))];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

async function main() {
  console.log('Fetching all pages...');
  const pages = await fetchAllPages();
  console.log(`Total pages: ${pages.length}`);

  const csv = toCsv(pages);
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, csv, 'utf8');
  console.log(`Exported ${pages.length} rows to ${OUT}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
