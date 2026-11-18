"use strict";
/**
 * Database updates without manual SQL: when SUPABASE_DB_URL is set (Supabase → Connect → connection string),
 * every file in /migrations runs at startup, in name order. Files must be safe to run again (if not exists).
 */
const fs = require("fs");
const path = require("path");
module.exports = async function migrate(log = console.log) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) { log("[migrate] SUPABASE_DB_URL not set — skipped"); return { skipped: true }; }
  const { Client } = require("pg");
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  try {
    for (const f of files) { await db.query(fs.readFileSync(path.join(dir, f), "utf8")); log(`[migrate] ${f} ok`); }
  } finally { await db.end(); }
  return { files };
};
