'use strict';

const { query, queryOne } = require('./db');

// Settings are stored as strings; callers ask for the type they want.
// Missing keys fail loudly — no silent defaults at read time. The defaults
// live in schema.sql and are seeded on first deploy.

async function getRawSetting(key) {
  const row = await queryOne('SELECT value FROM settings WHERE setting_key = ?', [key]);
  if (row === null) {
    throw new Error(`Missing setting: ${key}. Did schema.sql seeds run?`);
  }
  return row.value;
}

async function getString(key) {
  return await getRawSetting(key);
}

async function getInt(key) {
  const v = await getRawSetting(key);
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || String(n) !== v.trim()) {
    throw new Error(`Setting ${key}=${JSON.stringify(v)} is not a valid integer`);
  }
  return n;
}

async function getNumber(key) {
  const v = await getRawSetting(key);
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Setting ${key}=${JSON.stringify(v)} is not a valid number`);
  }
  return n;
}

async function setSetting(key, value) {
  if (typeof value !== 'string') {
    throw new Error(`setSetting(${key}) expects string value, got ${typeof value}`);
  }
  await query(
    'INSERT INTO settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, value]
  );
}

async function getAllSettings() {
  const rows = await query('SELECT setting_key, value, updated_at FROM settings ORDER BY setting_key');
  return rows.map((r) => ({ key: r.setting_key, value: r.value, updated_at: r.updated_at }));
}

module.exports = { getString, getInt, getNumber, setSetting, getAllSettings };
