// POST /api/steps
// Body: { date: "YYYY-MM-DD", steps: 9247 }
// Header: x-shortcut-secret: <your secret>
//
// Stores the count under key `steps:<date>` in Vercel KV.
// Called once a day by the iOS Shortcut.

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // CORS — allow your app to call this from the browser too
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-shortcut-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: only requests with the right secret can write
  const provided = req.headers['x-shortcut-secret'];
  const expected = process.env.SHORTCUT_SECRET;
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse body (Vercel auto-parses JSON when Content-Type is set)
  const { date, steps } = req.body || {};

  // Validate
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date (expected YYYY-MM-DD)' });
  }
  const stepCount = parseInt(steps, 10);
  if (isNaN(stepCount) || stepCount < 0 || stepCount > 200000) {
    return res.status(400).json({ error: 'Invalid steps value' });
  }

  try {
    await kv.set(`steps:${date}`, stepCount);
    // Also keep a sorted index so we can list recent days efficiently
    await kv.zadd('steps:index', { score: new Date(date).getTime(), member: date });
    return res.status(200).json({ ok: true, date, steps: stepCount });
  } catch (err) {
    return res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
}
