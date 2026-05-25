'use strict';

const mysql = require('mysql2/promise');

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function buildPoolConfig() {
  const base = {
    user:     requireEnv('MYSQL_USER'),
    password: requireEnv('MYSQL_PASSWORD'),
    database: requireEnv('MYSQL_DATABASE'),
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: false,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    dateStrings: false,
  };

  const cloudSqlInstance = process.env.CLOUD_SQL_CONNECTION_NAME;
  if (cloudSqlInstance) {
    base.socketPath = `/cloudsql/${cloudSqlInstance}`;
    return base;
  }

  base.host = requireEnv('MYSQL_HOST');
  base.port = parseInt(process.env.MYSQL_PORT || '3306', 10);
  if (!Number.isInteger(base.port) || base.port <= 0) {
    throw new Error(`MYSQL_PORT must be a positive integer; got ${process.env.MYSQL_PORT}`);
  }
  return base;
}

let _pool = null;

function pool() {
  if (_pool) return _pool;
  _pool = mysql.createPool(buildPoolConfig());
  return _pool;
}

async function query(sql, params) {
  const [rows] = await pool().execute(sql, params ?? []);
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error(`queryOne expected at most 1 row, got ${rows.length}: ${sql}`);
  }
  return rows[0];
}

async function withTransaction(fn) {
  const conn = await pool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, queryOne, withTransaction };
