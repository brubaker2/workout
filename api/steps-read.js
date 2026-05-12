// GET /api/steps-read
// Returns: { last7: [{date, steps}], avg28, today }
//
// Read-only and public — anyone with the URL can call this.
// No secret required; we're just exposing step counts which
// aren't sensitive. If you want to lock this down too, add a
// similar x-shortcut-secret header check as in steps.js.

import { kv } from '@vercel/kv';

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Generate the date keys we need: yesterday going back 28 days, plus today
    const needed = [];
    for (let i = 0; i <= 28; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      needed.push(ymd(d));
    }

    // Batch fetch — kv.mget returns array in same order, nulls for missing
    const keys = needed.map(d => `steps:${d}`);
    const values = await kv.mget(...keys);
    const map = {};
    needed.forEach((d, i) => { map[d] = values[i]; });

    // Today (may be null if Shortcut hasn't run yet today; that's expected)
    const todayKey = ymd(today);
    const todaySteps = map[todayKey] ?? 0;

    // Last 7 days ending YESTERDAY (today not included)
    const last7 = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = ymd(d);
      last7.push({ date: key, steps: map[key] ?? 0 });
    }

    // 28-day average ending yesterday (only counting days we have data for)
    let sum = 0, count = 0;
    for (let i = 28; i >= 1; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const v = map[ymd(d)];
      if (typeof v === 'number') { sum += v; count++; }
    }
    const avg28 = count > 0 ? Math.round(sum / count) : 0;

    return res.status(200).json({
      today: todaySteps,
      last7,
      avg28,
      daysWithData: count,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Storage error', detail: String(err) });
  }
}
