import React, { useState, useMemo, useEffect } from 'react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, BarChart, Bar, Cell, ReferenceLine } from 'recharts';
import { Activity, Zap, Flame, BarChart3, Settings, Sparkles, Minus, Plus, RotateCcw, Eye, X, Footprints } from 'lucide-react';
import localforage from 'localforage';

// ============================================================
// PERSISTENCE — localForage uses IndexedDB under the hood, with
// automatic fallback to WebSQL/localStorage on browsers that don't
// support it. Stores per-exercise weight overrides and bodyweight
// across sessions.
// ============================================================
localforage.config({
  name: 'Strength',
  storeName: 'app_state',
  description: 'Per-exercise weight overrides and user profile data',
});
const STORAGE_KEYS = {
  overrides: 'weight-overrides',
  bodyweight: 'bodyweight',
};

// ============================================================
// SCIENTIFIC FOUNDATIONS
// ============================================================
// 1RM Estimation: Average of Epley (1985) and Brzycki (1993)
//   - Epley: 1RM = weight × (1 + reps/30)
//   - Brzycki: 1RM = weight × 36/(37 - reps)
//   Validated within 2-4% of true 1RM in the 3-8 rep range
//   (DiStasio 2014; LeSuer & McCormick 1997).
//
// Strength Standards: bodyweight ratios from ExRx norms,
//   Symmetric Strength dataset, Stronger By Science (Nuckols).
// ============================================================

const epley = (w, r) => w * (1 + r / 30);
const brzycki = (w, r) => w * 36 / (37 - r);
const e1RM = (w, r) => r === 1 ? w : (epley(w, r) + brzycki(w, r)) / 2;

// Parses a line in either format:
//   "T bar row (3 x 8-10) - 115"        ← full (sets x reps) format
//   "Seated leg press 345"               ← bare-name + weight (assume 3x8)
const parseSet = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Format A: name (sets x reps[-repHigh]) - weight
  const fullMatch = trimmed.match(/^(.+?)\s*\(\s*(\d+)\s*x\s*(\d+)(?:\s*-\s*(\d+))?\s*\)\s*(?:-\s*(.+))?$/);
  if (fullMatch) {
    const [, name, sets, repLow, repHigh, weightStr] = fullMatch;
    const repsLow = parseInt(repLow);
    const repsHigh = repHigh ? parseInt(repHigh) : repsLow;
    const reps = Math.round((repsLow + repsHigh) / 2);
    const { weight, isBodyweight, perSide } = parseWeight(weightStr);
    return { name: name.trim(), sets: parseInt(sets), repsLow, repsHigh, reps, weight, isBodyweight, perSide };
  }

  // Format B: name <weight>      e.g. "Seated leg press 345" or "linear hack press 45s"
  const bareMatch = trimmed.match(/^([A-Za-z][A-Za-z \-\/\[\]]+?)\s+(\d+(?:\.\d+)?s?(?:\s*ea side)?)\s*$/);
  if (bareMatch) {
    const [, name, weightStr] = bareMatch;
    const { weight, isBodyweight, perSide } = parseWeight(weightStr);
    return { name: name.trim(), sets: 3, repsLow: 10, repsHigh: 10, reps: 10, weight, isBodyweight, perSide };
  }
  return null;
};

const parseWeight = (weightStr) => {
  let weight = 0, isBodyweight = false, perSide = false;
  if (!weightStr) return { weight, isBodyweight, perSide };
  const w = weightStr.toLowerCase().trim();
  if (w.includes('body')) return { weight: 0, isBodyweight: true, perSide: false };
  const num = parseFloat(w.replace(/[^\d.]/g, ''));
  weight = isNaN(num) ? 0 : num;
  // Trailing "s" (like "50s" for "50 lb dumbbells per hand") OR explicit "ea side"
  if (/\d+\s*s\b/.test(w) || w.includes('ea side') || w.includes('each side')) perSide = true;
  return { weight, isBodyweight, perSide };
};

// New lift.txt content
const RAW = `T bar row (3 x 8-10) - 115
Goblet Squat (3 x 8-10) - 75
Goodmorning (3 x 8-10) - 80
Tricep press down (3 x 8-10) - 70

DB fly (3 x 8-10) - 40
Split squat (3 x 8) - 50s
Hamstring roll outs (3 x 6-8) 
2/3 squat (3 x 5-6) - body weight 
Side raises (3 x 8-10) - 15s

Single arm DB row (3 x 8-10) - 55
2/3 Squat (3 x 6-8) - body weight 
Leg curl (3 x 10-12) - 145 

Hack Squat [hack slide] (3 x 8-10) - 105s
Chest press barbell (3 x 8-10) - 155
T bar row (3 x 8-10) - 115
Leg curl (3 x 10-12)- 145
Leaning side raise (3 x 8) - 15

Goblet Squat (3 x 8-10) - 75 
Goodmorning (3 x 8-10) - 80
Side raises (3 x 8-10) - 15s
Tricep press down (3 x 8-10) - 70

Split Squat (3 x 8) - 50
Cable row (3 x 8-12) - 115
DB RDL (3 x 8-12) - 40s
Chest Machine barbell (3 x 8-12) - 155
Full ROM Side raises (3 x 8-12) - 10s
Db hammer curls (3 x 8-12) - 20s 

Standing Lat Pulldown (3 x 8-10) - 120
Goodmornings (3 x 8-10) - 75

cable row (3 x 8-12) - 115
Goodmornings (3 x 8-12)- 75
Machine dips (3 x 8-12) - 135

Heel elevated Goblet Squat (3 x 8-12) - 65
Single Arm row (3 x 10-12) - 55
Chest Press barbell (3 x 8-12) - 155
RDL (3 x 8-10) - 80
Side raises (3 x 8-10) - 15

Seated leg press 345
Bicep curl machine 100
Pectoral fly machine 135
linear hack press 45s
incline press barbell 120`;

// Normalize names so "T bar row" and "t bar row" merge
const nameKey = (n) => n.toLowerCase().replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();

// Build a deduped exercise pool (heaviest variant of each unique movement)
const EXERCISE_POOL = (() => {
  const map = {};
  RAW.split('\n').map(parseSet).filter(Boolean).forEach(ex => {
    const key = nameKey(ex.name);
    const cur = map[key];
    const score = ex.isBodyweight ? 0 : (ex.perSide ? ex.weight * 2 : ex.weight);
    const curScore = cur ? (cur.isBodyweight ? 0 : (cur.perSide ? cur.weight * 2 : cur.weight)) : -1;
    if (!cur || score > curScore) map[key] = ex;
  });
  return Object.values(map);
})();

// All sequences, used for stats
const SEQUENCES = RAW.split('\n\n').map((block, idx) => ({
  id: idx,
  exercises: block.split('\n').map(parseSet).filter(Boolean),
}));

// Exercise → muscle classification
const MUSCLE_MAP = {
  'incline press': { primary: 'chest', body: 'upper' },
  'chest press': { primary: 'chest', body: 'upper' },
  'chest machine': { primary: 'chest', body: 'upper' },
  'pectoral': { primary: 'chest', body: 'upper' },
  'fly': { primary: 'chest', body: 'upper' },
  'dip': { primary: 'chest', body: 'upper' },
  't bar row': { primary: 'back', body: 'upper' },
  'cable row': { primary: 'back', body: 'upper' },
  'single arm': { primary: 'back', body: 'upper' },
  'lat pulldown': { primary: 'back', body: 'upper' },
  'pulldown': { primary: 'back', body: 'upper' },
  'split squat': { primary: 'quads', body: 'lower' },
  'goblet squat': { primary: 'quads', body: 'lower' },
  'hack': { primary: 'quads', body: 'lower' },
  'leg press': { primary: 'quads', body: 'lower' },
  '2/3 squat': { primary: 'quads', body: 'lower' },
  'goodmorning': { primary: 'hamstrings', body: 'lower' },
  'rdl': { primary: 'hamstrings', body: 'lower' },
  'leg curl': { primary: 'hamstrings', body: 'lower' },
  'hamstring': { primary: 'hamstrings', body: 'lower' },
  'side raise': { primary: 'shoulders', body: 'upper' },
  'lateral raise': { primary: 'shoulders', body: 'upper' },
  'overhead press': { primary: 'shoulders', body: 'upper' },
  'tricep': { primary: 'triceps', body: 'upper' },
  'skull crusher': { primary: 'triceps', body: 'upper' },
  'bicep': { primary: 'biceps', body: 'upper' },
  'curl': { primary: 'biceps', body: 'upper' },
};

const classifyExercise = (name) => {
  const n = name.toLowerCase();
  for (const key of Object.keys(MUSCLE_MAP)) if (n.includes(key)) return MUSCLE_MAP[key];
  return { primary: 'other', body: 'upper' };
};

const STANDARDS = {
  chest: { novice: 0.75, intermediate: 1.10, advanced: 1.50, elite: 1.90 },
  back: { novice: 0.65, intermediate: 1.00, advanced: 1.40, elite: 1.80 },
  quads: { novice: 0.90, intermediate: 1.40, advanced: 1.90, elite: 2.40 },
  hamstrings: { novice: 0.80, intermediate: 1.25, advanced: 1.70, elite: 2.20 },
  shoulders: { novice: 0.45, intermediate: 0.70, advanced: 0.95, elite: 1.20 },
  triceps: { novice: 0.30, intermediate: 0.50, advanced: 0.70, elite: 0.95 },
  biceps: { novice: 0.25, intermediate: 0.40, advanced: 0.55, elite: 0.75 },
};

const tierFromRatio = (ratio, std) => {
  if (ratio >= std.elite) return { tier: 'Elite', score: 100 };
  if (ratio >= std.advanced) return { tier: 'Advanced', score: 75 + 25 * (ratio - std.advanced) / (std.elite - std.advanced) };
  if (ratio >= std.intermediate) return { tier: 'Intermediate', score: 50 + 25 * (ratio - std.intermediate) / (std.advanced - std.intermediate) };
  if (ratio >= std.novice) return { tier: 'Novice', score: 25 + 25 * (ratio - std.novice) / (std.intermediate - std.novice) };
  return { tier: 'Untrained', score: Math.max(5, 25 * ratio / std.novice) };
};

// Machine-vs-free-weight correction factor.
// Machines (cams, leverage, stacks, back support) move more weight than
// equivalent free-weight movements. Strength standards are calibrated for
// free-weight lifts, so we discount machine lifts before comparing.
// Source: Schwanbeck et al. (2009) on machine vs free-weight EMG;
//         Saeterbakken et al. (2011) on bench press vs machine press;
//         Stronger By Science discussion of leg press inflation.
const machineFactor = (name) => {
  const n = name.toLowerCase();
  // Leg presses and hack presses notoriously inflate (assisted angle, sled)
  if (/leg press|hack press|hack squat|hack slide/i.test(n)) return 0.45;
  // Bicep/pec/lat machines with weight stacks
  if (/bicep curl machine/i.test(n)) return 0.55;
  if (/pectoral fly machine|chest machine|fly machine/i.test(n)) return 0.65;
  if (/lat pulldown|pulldown/i.test(n)) return 0.85;
  if (/preacher.*machine|curl machine/i.test(n)) return 0.65;
  if (/machine dip|machine press/i.test(n)) return 0.80;
  // Cable lifts are closer to free-weight but slightly assisted
  if (/cable/i.test(n)) return 0.90;
  // Default: no correction (free weights, dumbbells, barbells)
  return 1.0;
};

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [tab, setTab] = useState('home');
  const [bodyweight, setBodyweight] = useState(190);
  // Per-exercise weight overrides keyed by nameKey.
  // When the user updates a weight on the Generate tab, we store the new
  // raw value here. bestLifts / muscleScores read overrides first, then
  // fall back to the original lift.txt values.
  const [weightOverrides, setWeightOverrides] = useState({});
  // The current generated workout, lifted to App level so it persists
  // across tab navigation. null = no workout generated yet (show empty state).
  const [workout, setWorkout] = useState(null);
  // Tracks whether we've finished reading from IndexedDB. Prevents the
  // "save" effects from firing with default values during initial mount
  // and overwriting real persisted data.
  const [hydrated, setHydrated] = useState(false);

  // Hydrate persisted state on mount
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      localforage.getItem(STORAGE_KEYS.overrides),
      localforage.getItem(STORAGE_KEYS.bodyweight),
    ]).then(([savedOverrides, savedBW]) => {
      if (cancelled) return;
      if (savedOverrides && typeof savedOverrides === 'object') setWeightOverrides(savedOverrides);
      if (typeof savedBW === 'number' && savedBW > 0) setBodyweight(savedBW);
      setHydrated(true);
    }).catch(() => {
      // Storage unavailable (e.g. running in Claude artifact sandbox) — proceed in-memory
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Persist weightOverrides on change (after hydration completes)
  useEffect(() => {
    if (!hydrated) return;
    localforage.setItem(STORAGE_KEYS.overrides, weightOverrides).catch(() => {});
  }, [weightOverrides, hydrated]);

  // Persist bodyweight on change
  useEffect(() => {
    if (!hydrated) return;
    localforage.setItem(STORAGE_KEYS.bodyweight, bodyweight).catch(() => {});
  }, [bodyweight, hydrated]);

  const updateWeight = (name, newWeight) => {
    setWeightOverrides(prev => ({ ...prev, [nameKey(name)]: newWeight }));
  };

  const bestLifts = useMemo(() => {
    const map = {};
    SEQUENCES.forEach(s => {
      s.exercises.forEach(ex => {
        if (ex.isBodyweight) return;
        const key = nameKey(ex.name);
        // If user has overridden this exercise's weight, use the override.
        const effectiveWeight = weightOverrides[key] !== undefined ? weightOverrides[key] : ex.weight;
        if (effectiveWeight === 0) return;
        // Only add sled weight (45 lb) for barbell leg press/hack machines.
        // Dumbbell "per side" exercises (e.g. "20s" = 20 lb each hand) should
        // just be doubled, not have a 45 lb bar added.
        const isSleddedMachine = /leg press|hack press|hack squat|hack slide/i.test(ex.name);
        const rawWeight = ex.perSide
          ? (isSleddedMachine ? effectiveWeight * 2 + 45 : effectiveWeight * 2)
          : effectiveWeight;
        const factor = machineFactor(ex.name);
        const correctedWeight = rawWeight * factor;
        const est = e1RM(correctedWeight, ex.reps);
        if (!map[key] || est > map[key].e1rm) {
          map[key] = {
            name: ex.name,
            e1rm: est,
            rawWeight,
            factor,
            weight: correctedWeight,
            reps: ex.reps,
            muscle: classifyExercise(ex.name)
          };
        }
      });
    });
    // Compute per-lift strength score (0-100) using the lift's primary muscle's
    // tier thresholds. This gives every individual lift a scored value so we
    // can rank them best→worst regardless of muscle group.
    return Object.values(map).map(lift => {
      const m = lift.muscle.primary;
      if (m === 'other' || !STANDARDS[m]) return { ...lift, liftScore: null };
      const ratio = lift.e1rm / bodyweight;
      const t = tierFromRatio(ratio, STANDARDS[m]);
      return { ...lift, liftScore: t.score, liftTier: t.tier, liftRatio: ratio };
    });
  }, [bodyweight, weightOverrides]);

  const muscleScores = useMemo(() => {
    const groups = {};
    bestLifts.forEach(lift => {
      const m = lift.muscle.primary;
      if (m === 'other') return;
      const ratio = lift.e1rm / bodyweight;
      if (!groups[m]) groups[m] = [];
      groups[m].push(ratio);
    });
    const scores = {};
    for (const m of Object.keys(STANDARDS)) {
      const ratios = groups[m] || [];
      if (ratios.length === 0) { scores[m] = { score: 0, tier: 'Untested', ratio: 0 }; continue; }
      const best = Math.max(...ratios);
      const t = tierFromRatio(best, STANDARDS[m]);
      scores[m] = { ...t, ratio: best };
    }
    return scores;
  }, [bestLifts, bodyweight]);

  const overallScore = useMemo(() => {
    const vals = Object.values(muscleScores).map(s => s.score).filter(s => s > 0);
    return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0) / vals.length) : 0;
  }, [muscleScores]);

  return (
    <div className="min-h-screen w-full" style={{
      background: 'linear-gradient(180deg, #f5f5f7 0%, #ffffff 100%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
    }}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .glass { background: rgba(255,255,255,0.72); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
        .card { background: white; border-radius: 22px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06); animation: fadeUp 0.5s ease both; }
        .haptic { transition: transform 0.15s cubic-bezier(0.4,0,0.2,1); }
        .haptic:active { transform: scale(0.96); }
        .shimmer-bg { background: linear-gradient(90deg, #FF375F 0%, #FF9500 50%, #FF375F 100%); background-size: 200% 100%; animation: shimmer 3s linear infinite; }
        body, html { -webkit-font-smoothing: antialiased; }
      `}</style>

      <div className="max-w-md mx-auto pb-28">
        <header className="px-5 pt-12 pb-4 sticky top-0 glass z-10">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-xs font-semibold tracking-wider uppercase" style={{color:'#FF375F'}}>Thursday · May 7</p>
              <h1 className="text-3xl font-bold tracking-tight" style={{color:'#1d1d1f', letterSpacing:'-0.02em'}}>
                {tab === 'home' ? 'Strength' : tab === 'generate' ? 'Generate' : tab === 'cardio' ? 'Cardio' : tab === 'charts' ? 'Insights' : 'Profile'}
              </h1>
            </div>
            <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{background:'linear-gradient(135deg,#FF375F,#FF9500)'}}>
              <span className="text-white font-bold text-sm">SC</span>
            </div>
          </div>
        </header>

        <main className="px-5 pt-3 space-y-4">
          {tab === 'home' && <HomeView overall={overallScore} muscleScores={muscleScores} bestLifts={bestLifts} bodyweight={bodyweight} />}
          {tab === 'generate' && <GenerateView updateWeight={updateWeight} weightOverrides={weightOverrides} workout={workout} setWorkout={setWorkout} />}
          {tab === 'cardio' && <CardioView />}
          {tab === 'charts' && <ChartsView muscleScores={muscleScores} />}
          {tab === 'profile' && <ProfileView bodyweight={bodyweight} setBodyweight={setBodyweight} weightOverrides={weightOverrides} setWeightOverrides={setWeightOverrides} hydrated={hydrated} />}
        </main>

        <nav className="fixed bottom-0 left-0 right-0 glass border-t border-black/5">
          <div className="max-w-md mx-auto flex justify-around py-2 pb-6">
            {[
              { id:'home', icon: Activity, label:'Today' },
              { id:'generate', icon: Sparkles, label:'Generate' },
              { id:'cardio', icon: Footprints, label:'Cardio' },
              { id:'charts', icon: BarChart3, label:'Insights' },
              { id:'profile', icon: Settings, label:'Profile' },
            ].map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} className="haptic flex flex-col items-center gap-1 px-3 py-1">
                  <Icon size={24} strokeWidth={active ? 2.4 : 1.8} color={active ? '#FF375F' : '#86868b'} />
                  <span className="text-[10px] font-medium" style={{color: active ? '#FF375F' : '#86868b'}}>{t.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}

// ============================================================
// HOME VIEW
// ============================================================
function HomeView({ overall, muscleScores, bestLifts, bodyweight }) {
  const tier = overall >= 75 ? 'Advanced' : overall >= 50 ? 'Intermediate' : overall >= 25 ? 'Novice' : 'Building';
  const scoredLifts = bestLifts.filter(l => l.liftScore !== null);
  const topLifts = [...scoredLifts].sort((a,b) => b.liftScore - a.liftScore).slice(0, 3);
  const bottomLifts = [...scoredLifts].sort((a,b) => a.liftScore - b.liftScore).slice(0, 3);

  return (
    <>
      <div className="card p-6" style={{animationDelay:'0ms'}}>
        <div className="flex items-center gap-5">
          <StrengthRing score={overall} />
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'#86868b'}}>Strength Score</p>
            <p className="text-4xl font-bold" style={{color:'#1d1d1f', letterSpacing:'-0.02em'}}>{overall}<span className="text-xl font-medium" style={{color:'#86868b'}}>/100</span></p>
            <div className="inline-flex items-center gap-1.5 mt-1.5 px-2.5 py-1 rounded-full" style={{background:'#FFF0F3'}}>
              <Zap size={12} fill="#FF375F" color="#FF375F" />
              <span className="text-xs font-semibold" style={{color:'#FF375F'}}>{tier} Tier</span>
            </div>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed" style={{color:'#424245'}}>
          Calculated from your top sets across {Object.values(muscleScores).filter(s=>s.score>0).length} muscle groups using Epley + Brzycki 1RM averaging, normalized to {bodyweight}lb body weight.
        </p>
      </div>

      <LiftRankCard
        title="Best Lifts"
        subtitle="Your strongest movements relative to bodyweight"
        lifts={topLifts}
        accent="#34C759"
        gradient="linear-gradient(135deg,#34C759,#30D158)"
        delay={120}
        bodyweight={bodyweight}
      />

      <LiftRankCard
        title="Worst Lifts"
        subtitle="Where there's the most room to grow"
        lifts={bottomLifts}
        accent="#FF3B30"
        gradient="linear-gradient(135deg,#FF3B30,#FF453A)"
        delay={180}
        bodyweight={bodyweight}
      />

      <div className="card p-5" style={{animationDelay:'240ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Your Exercise Library</p>
        <p className="text-2xl font-bold" style={{color:'#1d1d1f'}}>{EXERCISE_POOL.length}<span className="text-sm font-normal ml-1" style={{color:'#86868b'}}>exercises tracked</span></p>
        <p className="text-sm mt-2" style={{color:'#424245'}}>Tap <span className="font-semibold" style={{color:'#FF375F'}}>Generate</span> to build today's session — upper, lower, upper, lower, upper, upper.</p>
      </div>
    </>
  );
}

function StrengthRing({ score }) {
  const r = 38, c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  return (
    <div className="relative w-24 h-24">
      <svg viewBox="0 0 100 100" className="w-24 h-24 -rotate-90">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FF375F" />
            <stop offset="100%" stopColor="#FF9500" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={r} fill="none" stroke="#F5F5F7" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="url(#ringGrad)" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset} style={{transition:'stroke-dashoffset 1.2s cubic-bezier(0.4,0,0.2,1)'}} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <Flame size={28} fill="#FF375F" color="#FF375F" />
      </div>
    </div>
  );
}

function LiftRankCard({ title, subtitle, lifts, accent, gradient, delay, bodyweight }) {
  if (!lifts || lifts.length === 0) return null;
  return (
    <div className="card p-5" style={{animationDelay:`${delay}ms`}}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{color: accent}}>{title}</p>
      </div>
      <p className="text-xs mb-4" style={{color:'#86868b'}}>{subtitle}</p>
      <div className="space-y-3">
        {lifts.map((lift, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm tabular-nums" style={{background: gradient, color:'white'}}>{i+1}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate" style={{color:'#1d1d1f'}}>{lift.name}</p>
              <p className="text-xs" style={{color:'#86868b'}}>
                {lift.liftTier} · {lift.liftRatio.toFixed(2)}× BW
                {lift.factor < 1 && <span style={{color:'#FF9500'}}> · machine ×{lift.factor}</span>}
              </p>
            </div>
            <p className="text-base font-bold tabular-nums" style={{color: accent}}>
              {Math.round(lift.liftScore)}<span className="text-xs font-normal" style={{color:'#86868b'}}>/100</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// GENERATE VIEW — daily workout builder, sequence U/L/U/L/U/U
// ============================================================

// Exercises removed from rotation entirely
const BANNED_EXERCISES = new Set([
  'chest machine barbell',
  '2/3 squat',
]);

// Mutual-exclusion groups: if any member is already picked, all others
// in the same group are blocked for the rest of that session.
const EXCLUSION_GROUPS = [
  ['single arm db row', 'cable row'],
  ['db fly', 'pectoral fly machine'],
  ['chest press barbell', 'incline press barbell'],
  ['side raises', 'leaning side raise', 'full rom side raises'],
  ['db hammer curls', 'bicep curl machine'],
  ['goblet squat', 'heel elevated goblet squat', 'split squat'],
  ['hack squat', 'linear hack press'],
].map(group => group.map(n => n.toLowerCase()));

// Returns the set of nameKeys blocked by the exercises already picked
const blockedByExclusions = (usedKeys) => {
  const blocked = new Set();
  for (const group of EXCLUSION_GROUPS) {
    const usedInGroup = group.filter(n => usedKeys.has(n));
    if (usedInGroup.length > 0) group.forEach(n => blocked.add(n));
  }
  return blocked;
};

function GenerateView({ updateWeight, weightOverrides, workout, setWorkout }) {
  const [generating, setGenerating] = useState(false);

  // Filter banned exercises out of the pool once at generation time
  const filteredPool = EXERCISE_POOL.filter(ex => !BANNED_EXERCISES.has(nameKey(ex.name)));

  // Sequence: 6 slots — U, L, U, L, U, U
  const generate = () => {
    setGenerating(true);
    setTimeout(() => {
      const sequence = ['upper', 'lower', 'upper', 'lower', 'upper', 'upper'];
      const upperPool = filteredPool.filter(ex => classifyExercise(ex.name).body === 'upper');
      const lowerPool = filteredPool.filter(ex => classifyExercise(ex.name).body === 'lower');
      const used = new Set();
      const usedSubgroups = { upper: new Set(), lower: new Set() };

      const pick = (body) => {
        const pool = body === 'upper' ? upperPool : lowerPool;
        const blocked = blockedByExclusions(used);

        // Priority 1: unused, not blocked, new muscle subgroup
        let candidates = pool.filter(ex =>
          !used.has(nameKey(ex.name)) &&
          !blocked.has(nameKey(ex.name)) &&
          !usedSubgroups[body].has(classifyExercise(ex.name).primary)
        );
        // Priority 2: unused, not blocked (relax subgroup constraint)
        if (candidates.length === 0)
          candidates = pool.filter(ex => !used.has(nameKey(ex.name)) && !blocked.has(nameKey(ex.name)));
        // Priority 3: unused (relax exclusion constraint — shouldn't happen in practice)
        if (candidates.length === 0)
          candidates = pool.filter(ex => !used.has(nameKey(ex.name)));
        // Last resort
        if (candidates.length === 0) candidates = pool;

        const choice = candidates[Math.floor(Math.random() * candidates.length)];
        used.add(nameKey(choice.name));
        usedSubgroups[body].add(classifyExercise(choice.name).primary);
        return choice;
      };

      const picks = sequence.map((body) => {
        const choice = pick(body);
        const key = nameKey(choice.name);
        const baseline = weightOverrides[key] !== undefined ? weightOverrides[key] : choice.weight;
        return {
          ...choice,
          body,
          baselineWeight: baseline,
          workingWeight: baseline,
        };
      });
      setWorkout(picks);
      setGenerating(false);
    }, 700);
  };

  const cancel = () => setWorkout(null);

  const updateWorkingWeight = (idx, val) => {
    setWorkout(workout.map((ex, i) => i === idx ? { ...ex, workingWeight: val } : ex));
  };

  const saveWeight = (idx) => {
    const ex = workout[idx];
    updateWeight(ex.name, ex.workingWeight);
    setWorkout(workout.map((e, i) => i === idx ? { ...e, baselineWeight: e.workingWeight } : e));
  };

  if (!workout) {
    return (
      <>
        <div className="card p-6 text-center" style={{animationDelay:'0ms'}}>
          <div className="mx-auto w-20 h-20 rounded-full flex items-center justify-center mb-4" style={{background:'linear-gradient(135deg,#FF375F,#FF9500)'}}>
            <Sparkles size={36} color="white" strokeWidth={2.2} />
          </div>
          <h2 className="text-xl font-bold mb-1" style={{color:'#1d1d1f', letterSpacing:'-0.02em'}}>Today's Workout</h2>
          <p className="text-sm leading-relaxed mb-5" style={{color:'#86868b'}}>
            Six exercises drawn from your library, alternating upper and lower with two upper finishers.
          </p>
          <button onClick={generate} disabled={generating} className="haptic w-full py-4 rounded-2xl font-semibold text-white text-base flex items-center justify-center gap-2 shimmer-bg shadow-lg">
            {generating ? (
              <>
                <RotateCcw size={18} style={{animation:'spin 0.8s linear infinite'}} />
                Building your session…
              </>
            ) : (
              <>
                <Sparkles size={18} />
                Generate Workout
              </>
            )}
          </button>
        </div>

        <div className="card p-5" style={{animationDelay:'80ms'}}>
          <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Today's Sequence</p>
          <div className="space-y-2.5">
            {['upper','lower','upper','lower','upper','upper'].map((body, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold tabular-nums" style={{background:'#F5F5F7', color:'#1d1d1f'}}>{i+1}</div>
                <div className="w-2 h-7 rounded-full" style={{background: body === 'upper' ? '#FF375F' : '#FF9500'}} />
                <span className="text-sm font-medium capitalize" style={{color:'#1d1d1f'}}>{body} body</span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card p-5" style={{animationDelay:'0ms'}}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'#86868b'}}>Today's Session</p>
            <p className="text-2xl font-bold" style={{color:'#1d1d1f', letterSpacing:'-0.02em'}}>{workout.length}<span className="text-base font-normal" style={{color:'#86868b'}}> exercises</span></p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={cancel} className="haptic px-4 py-2 rounded-full text-sm font-semibold" style={{background:'#F5F5F7', color:'#86868b'}}>
              Cancel
            </button>
            <button onClick={generate} className="haptic px-4 py-2 rounded-full text-sm font-semibold flex items-center gap-1.5" style={{background:'#F5F5F7', color:'#FF375F'}}>
              <RotateCcw size={14} /> New
            </button>
          </div>
        </div>
      </div>

      {workout.map((ex, idx) => (
        <ExerciseCard
          key={idx}
          ex={ex}
          idx={idx}
          onUpdate={(val) => updateWorkingWeight(idx, val)}
          onSave={() => saveWeight(idx)}
        />
      ))}
    </>
  );
}

function ExerciseCard({ ex, idx, onUpdate, onSave }) {
  const [showDiagram, setShowDiagram] = useState(false);
  const bodyColor = ex.body === 'upper' ? '#FF375F' : '#FF9500';
  const stepWeight = ex.workingWeight >= 100 ? 5 : ex.workingWeight >= 25 ? 2.5 : 1;
  const adjust = (delta) => {
    const next = Math.max(0, +(ex.workingWeight + delta).toFixed(2));
    onUpdate(next);
  };

  const isDirty = !ex.isBodyweight && ex.workingWeight !== ex.baselineWeight;

  return (
    <>
      <div className="card overflow-hidden" style={{animationDelay:`${80 + idx*40}ms`}}>
        <div className="px-5 pt-4 pb-3 flex items-start gap-3">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 tabular-nums" style={{background:'#F5F5F7', color:'#1d1d1f'}}>{idx+1}</div>
          <div className="w-1 h-12 rounded-full flex-shrink-0" style={{background: bodyColor}} />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{color: bodyColor}}>{ex.body} body</p>
            <p className="text-base font-semibold leading-tight mt-0.5" style={{color:'#1d1d1f'}}>{ex.name}</p>
            {ex.isBodyweight && <p className="text-xs mt-0.5" style={{color:'#86868b'}}>Bodyweight</p>}
          </div>
        </div>

        <div className="px-5 pb-3">
          {!ex.isBodyweight ? (
            <Stepper
              label="Weight"
              value={ex.workingWeight}
              unit={ex.perSide ? 'lb/side' : 'lb'}
              onMinus={() => adjust(-stepWeight)}
              onPlus={() => adjust(stepWeight)}
              color={bodyColor}
            />
          ) : (
            <div className="rounded-2xl p-3 flex flex-col items-center justify-center" style={{background:'#F5F5F7'}}>
              <p className="text-[10px] font-semibold uppercase tracking-wide" style={{color:'#86868b'}}>Weight</p>
              <p className="text-base font-bold mt-1" style={{color:'#1d1d1f'}}>BW</p>
            </div>
          )}
        </div>

        <div className="px-5 pb-4 flex gap-2">
          <button
            onClick={() => setShowDiagram(true)}
            className="haptic flex-1 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5"
            style={{background:'#F5F5F7', color:'#1d1d1f'}}
          >
            <Eye size={14} strokeWidth={2.2} /> Visualize
          </button>
          {!ex.isBodyweight && (
            <button
              onClick={onSave}
              disabled={!isDirty}
              className="haptic flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{
                background: isDirty ? bodyColor : '#F5F5F7',
                color: isDirty ? 'white' : '#C7C7CC',
                cursor: isDirty ? 'pointer' : 'default',
                boxShadow: isDirty ? `0 2px 8px ${bodyColor}40` : 'none',
              }}
            >
              Update
            </button>
          )}
        </div>
      </div>

      {showDiagram && (
        <ExerciseDiagramModal ex={ex} bodyColor={bodyColor} onClose={() => setShowDiagram(false)} />
      )}
    </>
  );
}

// ============================================================
// EXERCISE DIAGRAM — bare-bones stick figure showing the movement
// ============================================================
function ExerciseDiagramModal({ ex, bodyColor, onClose }) {
  const diagram = getDiagram(ex.name);
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-5"
      style={{background:'rgba(0,0,0,0.45)', backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)', animation:'fadeUp 0.2s ease both'}}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="card w-full max-w-sm overflow-hidden"
        style={{animation:'fadeUp 0.3s ease both'}}
      >
        <div className="px-5 pt-5 pb-3 flex items-start gap-3">
          <div className="w-1 h-12 rounded-full flex-shrink-0" style={{background: bodyColor}} />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{color: bodyColor}}>{ex.body} body</p>
            <p className="text-base font-semibold leading-tight mt-0.5" style={{color:'#1d1d1f'}}>{ex.name}</p>
          </div>
          <button onClick={onClose} className="haptic w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{background:'#F5F5F7'}}>
            <X size={16} color="#86868b" strokeWidth={2.5} />
          </button>
        </div>

        <div className="px-5 py-4 flex justify-center" style={{background:'#FAFAFA'}}>
          {diagram.svg(bodyColor)}
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{color:'#86868b'}}>How To</p>
          <p className="text-sm leading-relaxed" style={{color:'#1d1d1f'}}>{diagram.howTo}</p>
        </div>
      </div>
    </div>
  );
}

// Pattern matchers map exercise names to a diagram + how-to.
// Order matters — first match wins, so put more specific patterns first.
const DIAGRAM_PATTERNS = [
  { test: n => /goblet squat/i.test(n), key: 'goblet' },
  { test: n => /split squat/i.test(n), key: 'split' },
  { test: n => /hack squat|hack press|leg press/i.test(n), key: 'legpress' },
  { test: n => /goodmorning/i.test(n), key: 'goodmorning' },
  { test: n => /rdl/i.test(n), key: 'rdl' },
  { test: n => /leg curl/i.test(n), key: 'legcurl' },
  { test: n => /hamstring/i.test(n), key: 'hamroll' },
  { test: n => /incline press/i.test(n), key: 'incline' },
  { test: n => /chest press|chest machine/i.test(n), key: 'press' },
  { test: n => /fly/i.test(n), key: 'fly' },
  { test: n => /dip/i.test(n), key: 'dip' },
  { test: n => /t bar row|cable row|single arm/i.test(n), key: 'row' },
  { test: n => /lat pulldown|pulldown/i.test(n), key: 'pulldown' },
  { test: n => /side raise|lateral raise/i.test(n), key: 'sideraise' },
  { test: n => /overhead press/i.test(n), key: 'ohp' },
  { test: n => /tricep press/i.test(n), key: 'tripress' },
  { test: n => /skull/i.test(n), key: 'skull' },
  { test: n => /hammer curl|bicep curl|curl/i.test(n), key: 'curl' },
];

const getDiagram = (name) => {
  for (const p of DIAGRAM_PATTERNS) if (p.test(name)) return DIAGRAMS[p.key];
  return DIAGRAMS.generic;
};

// Stick-figure SVG primitives: head circle, torso line, limb segments,
// optional dumbbell/bar/arrow markers. All diagrams use a 200x200 viewBox.
const StickPerson = ({ children, color }) => (
  <svg viewBox="0 0 200 200" className="w-56 h-56" style={{filter:'drop-shadow(0 2px 4px rgba(0,0,0,0.06))'}}>
    {children}
  </svg>
);

// Reusable bits
const Head = ({ cx, cy, r=10 }) => <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1d1d1f" strokeWidth="2.5" />;
const Line = ({ x1, y1, x2, y2, color='#1d1d1f', w=2.5 }) => <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={w} strokeLinecap="round" />;
const Barbell = ({ x1, y1, x2, y2, color }) => (
  <>
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="3" strokeLinecap="round" />
    <circle cx={x1} cy={y1} r="6" fill={color} />
    <circle cx={x2} cy={y2} r="6" fill={color} />
  </>
);
const Dumbbell = ({ cx, cy, color }) => (
  <g>
    <rect x={cx-9} y={cy-3} width="18" height="6" fill={color} rx="1" />
    <rect x={cx-12} y={cy-7} width="4" height="14" fill={color} rx="1" />
    <rect x={cx+8} y={cy-7} width="4" height="14" fill={color} rx="1" />
  </g>
);
const Arrow = ({ x, y, dy, color }) => (
  <g>
    <line x1={x} y1={y} x2={x} y2={y+dy} stroke={color} strokeWidth="2" strokeDasharray="3 3" />
    <polygon points={dy > 0 ? `${x-4},${y+dy-6} ${x+4},${y+dy-6} ${x},${y+dy}` : `${x-4},${y+dy+6} ${x+4},${y+dy+6} ${x},${y+dy}`} fill={color} />
  </g>
);
const Floor = () => <line x1="20" y1="180" x2="180" y2="180" stroke="#C7C7CC" strokeWidth="2" />;
const Bench = ({ y=140 }) => <rect x="50" y={y} width="100" height="8" fill="#C7C7CC" rx="2" />;

const DIAGRAMS = {
  goblet: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        {/* Squat position */}
        <Head cx={100} cy={50} />
        <Line x1={100} y1={60} x2={100} y2={110} /> {/* torso */}
        <Line x1={100} y1={110} x2={75} y2={140} /> {/* upper leg L */}
        <Line x1={75} y1={140} x2={75} y2={180} /> {/* lower leg L */}
        <Line x1={100} y1={110} x2={125} y2={140} />
        <Line x1={125} y1={140} x2={125} y2={180} />
        {/* arms holding dumbbell at chest */}
        <Line x1={100} y1={75} x2={90} y2={95} />
        <Line x1={100} y1={75} x2={110} y2={95} />
        <Dumbbell cx={100} cy={95} color={c} />
        <Arrow x={155} y={70} dy={70} color={c} />
      </StickPerson>
    ),
    howTo: 'Hold a dumbbell vertically at your chest. Squat down keeping your chest up and elbows tucked between your knees. Drive through your heels to stand.'
  },
  split: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        <Head cx={100} cy={50} />
        <Line x1={100} y1={60} x2={100} y2={115} />
        {/* front leg bent */}
        <Line x1={100} y1={115} x2={75} y2={150} />
        <Line x1={75} y1={150} x2={75} y2={180} />
        {/* back leg extended */}
        <Line x1={100} y1={115} x2={135} y2={155} />
        <Line x1={135} y1={155} x2={140} y2={180} />
        {/* arms holding dumbbells */}
        <Line x1={100} y1={75} x2={85} y2={110} />
        <Line x1={100} y1={75} x2={115} y2={110} />
        <Dumbbell cx={85} cy={115} color={c} />
        <Dumbbell cx={115} cy={115} color={c} />
      </StickPerson>
    ),
    howTo: 'One foot forward, one back in a long stance. Lower until the front thigh is parallel to the floor, knee tracking over toes. Drive up through the front heel.'
  },
  legpress: {
    svg: (c) => (
      <StickPerson>
        {/* sled angle */}
        <line x1={30} y1={170} x2={170} y2={60} stroke="#C7C7CC" strokeWidth="2" />
        <line x1={30} y1={170} x2={30} y2={140} stroke="#C7C7CC" strokeWidth="2" />
        <Bench y={150} />
        {/* lying back, legs pushing up the sled */}
        <Head cx={45} cy={140} />
        <Line x1={55} y1={140} x2={95} y2={130} />
        {/* legs pressing */}
        <Line x1={95} y1={130} x2={130} y2={110} />
        <Line x1={130} y1={110} x2={150} y2={90} />
        {/* foot platform */}
        <rect x={140} y={75} width="22" height="4" fill={c} rx="1" />
        <Arrow x={170} y={110} dy={-30} color={c} />
      </StickPerson>
    ),
    howTo: 'Sit in the sled with feet shoulder-width on the platform. Lower under control until knees approach 90°. Press through mid-foot, locking out without slamming.'
  },
  goodmorning: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        {/* hinge forward, bar on shoulders */}
        <Head cx={75} cy={70} />
        <Line x1={85} y1={75} x2={130} y2={100} /> {/* torso angled forward */}
        {/* legs slight bend */}
        <Line x1={130} y1={100} x2={125} y2={140} />
        <Line x1={125} y1={140} x2={125} y2={180} />
        {/* bar across upper back */}
        <Barbell x1={70} y1={85} x2={100} y2={70} color={c} />
        <Arrow x={155} y={85} dy={20} color={c} />
      </StickPerson>
    ),
    howTo: 'Bar racked on upper back. Soft knees, hinge at the hips by pushing them backward. Keep a flat back. Reverse by squeezing glutes and pushing hips forward.'
  },
  rdl: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        <Head cx={100} cy={50} />
        <Line x1={100} y1={60} x2={115} y2={120} /> {/* hinge torso */}
        <Line x1={115} y1={120} x2={110} y2={180} /> {/* legs nearly straight */}
        {/* arms hanging with dumbbells */}
        <Line x1={102} y1={75} x2={95} y2={140} />
        <Line x1={102} y1={75} x2={120} y2={140} />
        <Dumbbell cx={95} cy={150} color={c} />
        <Dumbbell cx={120} cy={150} color={c} />
        <Arrow x={160} y={100} dy={40} color={c} />
      </StickPerson>
    ),
    howTo: 'Soft knees, dumbbells at your thighs. Hinge at the hips, pushing your butt back and lowering the weights along your legs. Stop when you feel hamstring stretch. Drive hips forward to stand.'
  },
  legcurl: {
    svg: (c) => (
      <StickPerson>
        {/* lying prone on a pad */}
        <Bench y={120} />
        <Head cx={45} cy={115} />
        <Line x1={55} y1={115} x2={120} y2={115} /> {/* torso */}
        {/* upper leg */}
        <Line x1={120} y1={115} x2={155} y2={115} />
        {/* lower leg curled up */}
        <Line x1={155} y1={115} x2={150} y2={75} />
        {/* pad on ankle */}
        <rect x={143} y={70} width="14" height="6" fill={c} rx="1" />
        <Arrow x={170} y={105} dy={-25} color={c} />
      </StickPerson>
    ),
    howTo: 'Lie face-down on the pad, ankles under the roller. Curl your heels toward your glutes by contracting your hamstrings. Lower under control.'
  },
  hamroll: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        {/* on back, knees bent, heels on a ball */}
        <circle cx={150} cy={150} r="20" fill="none" stroke="#C7C7CC" strokeWidth="2" />
        <Head cx={50} cy={170} />
        <Line x1={60} y1={170} x2={120} y2={150} /> {/* torso lifted into bridge */}
        <Line x1={120} y1={150} x2={140} y2={130} /> {/* upper leg */}
        <Line x1={140} y1={130} x2={150} y2={150} /> {/* lower leg to ball */}
        <Arrow x={175} y={140} dy={-15} color={c} />
      </StickPerson>
    ),
    howTo: 'Lie on your back with heels on a stability ball, hips lifted in a bridge. Pull the ball toward your hips by curling your heels in. Extend back out under control.'
  },
  incline: {
    svg: (c) => (
      <StickPerson>
        {/* incline bench */}
        <line x1={40} y1={170} x2={140} y2={100} stroke="#C7C7CC" strokeWidth="6" strokeLinecap="round" />
        {/* lying back */}
        <Head cx={140} cy={90} />
        <Line x1={140} y1={100} x2={75} y2={150} /> {/* torso along bench */}
        {/* arms pressing up */}
        <Line x1={130} y1={100} x2={140} y2={60} />
        <Line x1={155} y1={105} x2={165} y2={60} />
        <Barbell x1={130} y1={55} x2={170} y2={55} color={c} />
        <Arrow x={180} y={75} dy={-20} color={c} />
      </StickPerson>
    ),
    howTo: 'Bench at ~30°. Bar over upper chest, elbows tucked at ~45°. Lower under control to the upper chest, then press up and slightly back over your shoulders.'
  },
  press: {
    svg: (c) => (
      <StickPerson>
        <Bench y={140} />
        <Head cx={50} cy={130} />
        <Line x1={60} y1={130} x2={150} y2={130} /> {/* torso flat */}
        {/* legs off bench */}
        <Line x1={150} y1={130} x2={170} y2={170} />
        {/* arms pressing up */}
        <Line x1={100} y1={130} x2={100} y2={80} />
        <Line x1={130} y1={130} x2={130} y2={80} />
        <Barbell x1={90} y1={75} x2={140} y2={75} color={c} />
        <Arrow x={170} y={100} dy={-25} color={c} />
      </StickPerson>
    ),
    howTo: 'Lie flat with feet planted. Bar over mid-chest, elbows at ~45°. Lower with control to the chest, then press straight up to lockout.'
  },
  fly: {
    svg: (c) => (
      <StickPerson>
        <Bench y={140} />
        <Head cx={50} cy={130} />
        <Line x1={60} y1={130} x2={150} y2={130} />
        {/* arms wide in fly position */}
        <Line x1={100} y1={130} x2={70} y2={95} />
        <Line x1={130} y1={130} x2={160} y2={95} />
        <Dumbbell cx={70} cy={90} color={c} />
        <Dumbbell cx={160} cy={90} color={c} />
        {/* arc arrows */}
        <path d="M 70 90 Q 115 60 160 90" stroke={c} strokeWidth="2" fill="none" strokeDasharray="3 3" />
      </StickPerson>
    ),
    howTo: 'Lie flat, slight bend in elbows. Open your arms in a wide arc until you feel a chest stretch, then squeeze your chest to bring the dumbbells back together over your sternum.'
  },
  dip: {
    svg: (c) => (
      <StickPerson>
        {/* parallel bars */}
        <line x1={40} y1={100} x2={80} y2={100} stroke="#C7C7CC" strokeWidth="3" />
        <line x1={120} y1={100} x2={160} y2={100} stroke="#C7C7CC" strokeWidth="3" />
        {/* lowered position */}
        <Head cx={100} cy={75} />
        <Line x1={100} y1={85} x2={100} y2={130} /> {/* torso slight forward lean */}
        {/* arms supporting at bars */}
        <Line x1={92} y1={90} x2={70} y2={100} />
        <Line x1={108} y1={90} x2={130} y2={100} />
        {/* legs tucked */}
        <Line x1={100} y1={130} x2={85} y2={155} />
        <Line x1={100} y1={130} x2={115} y2={155} />
        <Arrow x={170} y={85} dy={25} color={c} />
      </StickPerson>
    ),
    howTo: 'Support yourself on parallel bars, arms locked. Lean slightly forward for chest emphasis. Lower until shoulders are just below elbows, then press back up.'
  },
  row: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        {/* hinged torso, pulling weight to ribs */}
        <Head cx={70} cy={75} />
        <Line x1={80} y1={80} x2={140} y2={105} /> {/* torso angled */}
        {/* legs slight bend */}
        <Line x1={140} y1={105} x2={135} y2={150} />
        <Line x1={135} y1={150} x2={130} y2={180} />
        {/* arm rowing weight up to ribs */}
        <Line x1={115} y1={92} x2={115} y2={130} />
        <Dumbbell cx={115} cy={140} color={c} />
        <Arrow x={155} y={130} dy={-30} color={c} />
      </StickPerson>
    ),
    howTo: 'Hinge at the hips with a flat back. Pull the weight toward your lower ribs, leading with your elbow. Squeeze your shoulder blade. Lower under control.'
  },
  pulldown: {
    svg: (c) => (
      <StickPerson>
        {/* cable from above */}
        <line x1={100} y1={20} x2={100} y2={70} stroke="#C7C7CC" strokeWidth="2" strokeDasharray="2 4" />
        <Barbell x1={75} y1={70} x2={125} y2={70} color={c} />
        {/* seated, pulling bar down */}
        <Head cx={100} cy={95} />
        <Line x1={100} y1={105} x2={100} y2={155} />
        {/* arms up holding bar */}
        <Line x1={100} y1={108} x2={80} y2={75} />
        <Line x1={100} y1={108} x2={120} y2={75} />
        {/* seated legs bent */}
        <Line x1={100} y1={155} x2={75} y2={170} />
        <Line x1={100} y1={155} x2={125} y2={170} />
        <Arrow x={155} y={75} dy={40} color={c} />
      </StickPerson>
    ),
    howTo: 'Sit with thighs secured under the pad. Grip wider than shoulders. Pull the bar to your upper chest by driving your elbows down and back. Control the return.'
  },
  sideraise: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        <Head cx={100} cy={50} />
        <Line x1={100} y1={60} x2={100} y2={140} />
        {/* arms raised laterally */}
        <Line x1={100} y1={75} x2={55} y2={75} />
        <Line x1={100} y1={75} x2={145} y2={75} />
        <Dumbbell cx={50} cy={75} color={c} />
        <Dumbbell cx={150} cy={75} color={c} />
        {/* legs */}
        <Line x1={100} y1={140} x2={85} y2={180} />
        <Line x1={100} y1={140} x2={115} y2={180} />
        <Arrow x={30} y={110} dy={-25} color={c} />
        <Arrow x={170} y={110} dy={-25} color={c} />
      </StickPerson>
    ),
    howTo: 'Stand tall, dumbbells at your sides, slight elbow bend. Raise the weights out to shoulder height, leading with your elbows. Pause briefly, then lower with control.'
  },
  ohp: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        <Head cx={100} cy={60} />
        <Line x1={100} y1={70} x2={100} y2={140} />
        {/* arms pressing overhead */}
        <Line x1={100} y1={75} x2={80} y2={35} />
        <Line x1={100} y1={75} x2={120} y2={35} />
        <Barbell x1={70} y1={30} x2={130} y2={30} color={c} />
        {/* legs */}
        <Line x1={100} y1={140} x2={85} y2={180} />
        <Line x1={100} y1={140} x2={115} y2={180} />
        <Arrow x={155} y={75} dy={-30} color={c} />
      </StickPerson>
    ),
    howTo: 'Bar at shoulder level, elbows slightly forward. Brace your core, press the bar straight overhead, finishing with arms locked and biceps near ears.'
  },
  tripress: {
    svg: (c) => (
      <StickPerson>
        {/* cable from above */}
        <line x1={120} y1={20} x2={120} y2={80} stroke="#C7C7CC" strokeWidth="2" strokeDasharray="2 4" />
        <Barbell x1={100} y1={80} x2={140} y2={80} color={c} />
        {/* standing, elbows at sides */}
        <Head cx={100} cy={60} />
        <Line x1={100} y1={70} x2={100} y2={150} />
        {/* upper arm tucked, forearm pressing down */}
        <Line x1={100} y1={90} x2={120} y2={110} />
        <Line x1={120} y1={110} x2={120} y2={80} />
        <Line x1={100} y1={150} x2={85} y2={180} />
        <Line x1={100} y1={150} x2={115} y2={180} />
        <Arrow x={160} y={90} dy={40} color={c} />
      </StickPerson>
    ),
    howTo: 'Stand close to the stack. Elbows pinned at your sides. Press the bar down by extending only your forearms. Squeeze your triceps at the bottom, then control the return.'
  },
  skull: {
    svg: (c) => (
      <StickPerson>
        <Bench y={140} />
        <Head cx={50} cy={130} />
        <Line x1={60} y1={130} x2={150} y2={130} />
        {/* upper arms vertical, forearms folded back toward head */}
        <Line x1={100} y1={130} x2={100} y2={90} />
        <Line x1={100} y1={90} x2={75} y2={115} />
        <Barbell x1={70} y1={120} x2={80} y2={110} color={c} />
        <Arrow x={150} y={100} dy={-20} color={c} />
      </StickPerson>
    ),
    howTo: 'Lie flat, arms perpendicular to your torso, weight over chest. Bend only your elbows to lower the bar toward your forehead. Extend back up by contracting your triceps.'
  },
  curl: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        <Head cx={100} cy={50} />
        <Line x1={100} y1={60} x2={100} y2={140} />
        {/* upper arms at sides, forearms curling up */}
        <Line x1={92} y1={75} x2={75} y2={105} />
        <Line x1={75} y1={105} x2={90} y2={85} />
        <Line x1={108} y1={75} x2={125} y2={105} />
        <Line x1={125} y1={105} x2={110} y2={85} />
        <Dumbbell cx={90} cy={80} color={c} />
        <Dumbbell cx={110} cy={80} color={c} />
        <Line x1={100} y1={140} x2={85} y2={180} />
        <Line x1={100} y1={140} x2={115} y2={180} />
        <Arrow x={155} y={120} dy={-30} color={c} />
      </StickPerson>
    ),
    howTo: 'Stand tall, elbows pinned at your sides. Curl the weight up by flexing only at the elbow. Squeeze the biceps at the top, then lower under full control.'
  },
  generic: {
    svg: (c) => (
      <StickPerson>
        <Floor />
        <Head cx={100} cy={55} />
        <Line x1={100} y1={65} x2={100} y2={130} />
        <Line x1={100} y1={80} x2={70} y2={110} />
        <Line x1={100} y1={80} x2={130} y2={110} />
        <Line x1={100} y1={130} x2={80} y2={170} />
        <Line x1={100} y1={130} x2={120} y2={170} />
        <circle cx={155} cy={90} r="14" fill="none" stroke={c} strokeWidth="2.5" strokeDasharray="3 3" />
      </StickPerson>
    ),
    howTo: 'Perform with controlled tempo, full range of motion, and a tight core. Focus on the working muscle.'
  },
};

function Stepper({ label, value, unit, onMinus, onPlus, color }) {
  return (
    <div className="rounded-2xl p-3" style={{background:'#F5F5F7'}}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-center" style={{color:'#86868b'}}>{label}</p>
      <div className="flex items-center justify-between mt-1.5 px-2">
        <button onClick={onMinus} className="haptic w-8 h-8 rounded-full flex items-center justify-center bg-white shadow-sm">
          <Minus size={14} color={color} strokeWidth={2.5} />
        </button>
        <span className="text-xl font-bold tabular-nums" style={{color:'#1d1d1f'}}>{value}</span>
        <button onClick={onPlus} className="haptic w-8 h-8 rounded-full flex items-center justify-center bg-white shadow-sm">
          <Plus size={14} color={color} strokeWidth={2.5} />
        </button>
      </div>
      {unit && <p className="text-[10px] text-center mt-1" style={{color:'#86868b'}}>{unit}</p>}
    </div>
  );
}

// ============================================================
// CARDIO VIEW — steps from API (with mock fallback)
// ============================================================
//
// Data flow:
//   1. iOS Shortcut runs daily, POSTs yesterday's step count to
//      /api/steps with the SHORTCUT_SECRET header.
//   2. The endpoint stores it in Vercel KV keyed by date.
//   3. This view fetches /api/steps-read on mount, which returns
//      the last 7 days + 28-day average + today's count.
//   4. While you're still setting up the Shortcut (or if the API
//      is unreachable), falls back to deterministic mock data so
//      the UI is never empty.

const STEP_GOAL = 10000;

// Deterministic mock so the UI looks realistic before real data lands
const mockSteps = (date) => {
  const day = date.getDay();
  const base = day === 0 || day === 6 ? 7200 : 9400;
  const seed = date.getFullYear() * 372 + (date.getMonth() + 1) * 31 + date.getDate();
  const noise = ((seed * 9301 + 49297) % 233280) / 233280;
  return Math.round(base + (noise - 0.5) * 3200);
};

const buildMockData = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const last7 = [];
  for (let i = 7; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    last7.push({ date: d.toISOString().slice(0,10), steps: mockSteps(d) });
  }
  let sum = 0;
  for (let i = 28; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    sum += mockSteps(d);
  }
  return { last7, avg28: Math.round(sum / 28), today: mockSteps(today), source: 'mock' };
};

function CardioView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/steps-read')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(json => {
        if (cancelled) return;
        // Only trust the API response if it actually has data
        if (json.daysWithData > 0 || json.today > 0) {
          setData({ ...json, source: 'api' });
        } else {
          setData(buildMockData());
          setError('No real data yet — showing mock');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setData(buildMockData());
        setError(`API unavailable (${err.message}) — showing mock`);
      });
    return () => { cancelled = true; };
  }, []);

  if (!data) {
    return (
      <div className="card p-6 text-center" style={{animationDelay:'0ms'}}>
        <p className="text-sm" style={{color:'#86868b'}}>Loading steps…</p>
      </div>
    );
  }

  const chartData = data.last7.map(d => {
    const date = new Date(d.date + 'T00:00:00');
    return {
      day: date.toLocaleDateString('en-US', { weekday: 'short' }),
      fullDate: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      steps: d.steps,
    };
  });

  const todayHitGoal = data.today >= STEP_GOAL;
  const todayProgress = Math.min(100, (data.today / STEP_GOAL) * 100);

  return (
    <>
      <div className="card p-6" style={{animationDelay:'0ms'}}>
        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{background:'linear-gradient(135deg,#FF375F,#FF9500)'}}>
            <Footprints size={28} color="white" strokeWidth={2.2} />
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'#86868b'}}>Today's Steps</p>
            <p className="text-5xl font-bold tabular-nums leading-none mt-1" style={{color:'#1d1d1f', letterSpacing:'-0.03em'}}>
              {data.today.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs mb-1.5" style={{color:'#86868b'}}>
          <span>Goal · {STEP_GOAL.toLocaleString()}</span>
          <span className="font-semibold" style={{color: todayHitGoal ? '#34C759' : '#FF375F'}}>
            {todayHitGoal ? '✓ Goal hit' : `${Math.round(todayProgress)}%`}
          </span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{background:'#F5F5F7'}}>
          <div className="h-full rounded-full transition-all duration-700" style={{
            width: `${todayProgress}%`,
            background: todayHitGoal ? 'linear-gradient(90deg,#34C759,#30D158)' : 'linear-gradient(90deg,#FF375F,#FF9500)',
          }} />
        </div>
      </div>

      <div className="card p-5" style={{animationDelay:'80ms'}}>
        <div className="flex items-baseline justify-between mb-1">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'#86868b'}}>Last 7 Days</p>
          <p className="text-xs" style={{color:'#86868b'}}>through yesterday</p>
        </div>
        <div className="flex items-baseline justify-between mb-4">
          <p className="text-2xl font-bold tabular-nums" style={{color:'#1d1d1f'}}>
            {Math.round(chartData.reduce((a,b) => a + b.steps, 0) / 7).toLocaleString()}
            <span className="text-sm font-normal ml-1" style={{color:'#86868b'}}>avg / day</span>
          </p>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{top: 5, right: 5, left: -10, bottom: 0}}>
            <defs>
              <linearGradient id="stepBarGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FF375F" />
                <stop offset="100%" stopColor="#FF9500" />
              </linearGradient>
            </defs>
            <XAxis dataKey="day" tick={{fontSize:11, fill:'#86868b', fontWeight:500}} axisLine={false} tickLine={false} />
            <YAxis tick={{fontSize:10, fill:'#86868b'}} axisLine={false} tickLine={false} width={40} tickFormatter={v => v >= 1000 ? `${v/1000}k` : v} />
            <Tooltip
              contentStyle={{borderRadius:12, border:'none', boxShadow:'0 4px 16px rgba(0,0,0,0.1)', fontSize:12}}
              formatter={(value) => [value.toLocaleString() + ' steps', '']}
              labelFormatter={(_, payload) => payload && payload[0] ? payload[0].payload.fullDate : ''}
            />
            <Bar dataKey="steps" fill="url(#stepBarGrad)" radius={[6, 6, 0, 0]} />
            <ReferenceLine y={data.avg28} stroke="#5856D6" strokeWidth={2} strokeDasharray="4 4" ifOverflow="extendDomain"
              label={{ value: `28-day avg · ${data.avg28.toLocaleString()}`, position: 'insideTopRight', fill:'#5856D6', fontSize: 10, fontWeight: 600 }} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {data.source === 'mock' && (
        <div className="card p-4" style={{animationDelay:'160ms', background:'#FFF8E7'}}>
          <p className="text-xs leading-relaxed" style={{color:'#8A6800'}}>
            <strong>Mock data.</strong> {error || 'Set up the iOS Shortcut to start sending real step counts to your /api/steps endpoint.'}
          </p>
        </div>
      )}
      {data.source === 'api' && data.daysWithData < 7 && (
        <div className="card p-4" style={{animationDelay:'160ms', background:'#E8F1FB'}}>
          <p className="text-xs leading-relaxed" style={{color:'#0040DD'}}>
            <strong>Building history.</strong> {data.daysWithData} of 28 days logged so far. The chart and averages will fill in as the iOS Shortcut runs each morning.
          </p>
        </div>
      )}
    </>
  );
}


// ============================================================
// CHARTS VIEW
// ============================================================
function ChartsView({ muscleScores }) {
  const radarData = Object.entries(muscleScores)
    .filter(([,s]) => s.score > 0)
    .map(([m, s]) => ({ muscle: m.charAt(0).toUpperCase()+m.slice(1), score: Math.round(s.score), full: 100 }));

  return (
    <>
      <div className="card p-5" style={{animationDelay:'0ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{color:'#86868b'}}>Symmetry Profile</p>
        <ResponsiveContainer width="100%" height={260}>
          <RadarChart data={radarData}>
            <PolarGrid stroke="#E5E5EA" />
            <PolarAngleAxis dataKey="muscle" tick={{fontSize:11, fill:'#1d1d1f', fontWeight:600}} />
            <PolarRadiusAxis tick={{fontSize:9, fill:'#86868b'}} angle={90} domain={[0,100]} />
            <Radar name="Score" dataKey="score" stroke="#FF375F" fill="#FF375F" fillOpacity={0.3} strokeWidth={2} />
          </RadarChart>
        </ResponsiveContainer>
        <p className="text-xs leading-relaxed mt-2" style={{color:'#86868b'}}>
          Larger and more circular = stronger and more balanced. Asymmetric points reveal undertrained body parts.
        </p>
      </div>

      <div className="card p-5" style={{animationDelay:'80ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Score by Body Part</p>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={radarData} layout="vertical" margin={{left:10}}>
            <XAxis type="number" domain={[0,100]} tick={{fontSize:10, fill:'#86868b'}} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="muscle" tick={{fontSize:11, fill:'#1d1d1f', fontWeight:500}} axisLine={false} tickLine={false} width={80} />
            <Tooltip contentStyle={{borderRadius:12, border:'none', boxShadow:'0 4px 16px rgba(0,0,0,0.1)', fontSize:12}} />
            <Bar dataKey="score" radius={[0,8,8,0]}>
              {radarData.map((d, i) => (
                <Cell key={i} fill={d.score < 25 ? '#FF3B30' : d.score < 50 ? '#FF9500' : d.score < 75 ? '#FFCC00' : '#34C759'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

// ============================================================
// PROFILE VIEW
// ============================================================
function ProfileView({ bodyweight, setBodyweight, weightOverrides, setWeightOverrides, hydrated }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const overrideCount = Object.keys(weightOverrides || {}).length;

  const reset = () => {
    setWeightOverrides({});
    setConfirmReset(false);
  };

  return (
    <>
      <div className="card p-5" style={{animationDelay:'0ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Profile</p>
        <Row label="Body Weight">
          <input type="number" value={bodyweight} onChange={e=>setBodyweight(parseFloat(e.target.value)||190)} className="w-20 text-right tabular-nums font-medium bg-transparent outline-none" style={{color:'#FF375F'}} />
          <span className="text-sm ml-1" style={{color:'#86868b'}}>lb</span>
        </Row>
        <Row label="Sex"><span className="text-sm" style={{color:'#86868b'}}>Male</span></Row>
        <Row label="Age"><span className="text-sm" style={{color:'#86868b'}}>26</span></Row>
        <Row label="Units"><span className="text-sm" style={{color:'#86868b'}}>Imperial</span></Row>
      </div>

      <div className="card p-5" style={{animationDelay:'60ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Storage</p>
        <Row label="Status">
          <span className="text-xs px-2 py-0.5 rounded-full" style={{background: hydrated?'#E8F8EE':'#FFF8E7', color: hydrated?'#34C759':'#8A6800'}}>
            {hydrated ? 'IndexedDB · synced' : 'Loading…'}
          </span>
        </Row>
        <Row label="Saved Overrides">
          <span className="text-sm tabular-nums" style={{color:'#86868b'}}>{overrideCount} {overrideCount === 1 ? 'lift' : 'lifts'}</span>
        </Row>
        {!confirmReset ? (
          <button onClick={() => setConfirmReset(true)} disabled={overrideCount === 0}
            className="haptic w-full mt-3 py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{background: overrideCount > 0 ? '#F5F5F7' : '#FAFAFA', color: overrideCount > 0 ? '#FF3B30' : '#C7C7CC'}}>
            Reset all weights
          </button>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => setConfirmReset(false)} className="haptic py-2.5 rounded-xl text-sm font-semibold" style={{background:'#F5F5F7', color:'#1d1d1f'}}>
              Cancel
            </button>
            <button onClick={reset} className="haptic py-2.5 rounded-xl text-sm font-semibold text-white" style={{background:'#FF3B30', boxShadow:'0 2px 8px #FF3B3040'}}>
              Confirm Reset
            </button>
          </div>
        )}
        <p className="text-xs mt-3 leading-relaxed" style={{color:'#86868b'}}>
          Weight updates and your bodyweight are saved in your browser's IndexedDB and persist across sessions. Reset reverts all weights back to their original lift.txt values.
        </p>
      </div>

      <div className="card p-5" style={{animationDelay:'120ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{color:'#86868b'}}>The Science</p>
        <p className="text-sm leading-relaxed mb-2" style={{color:'#424245'}}>
          Strength scores use the average of two validated 1RM equations:
        </p>
        <div className="space-y-1.5 ml-2">
          <p className="text-xs" style={{color:'#86868b'}}>• <strong style={{color:'#1d1d1f'}}>Epley (1985)</strong>: 1RM = w × (1 + r/30)</p>
          <p className="text-xs" style={{color:'#86868b'}}>• <strong style={{color:'#1d1d1f'}}>Brzycki (1993)</strong>: 1RM = w × 36/(37 − r)</p>
        </div>
        <p className="text-sm leading-relaxed mt-3" style={{color:'#424245'}}>
          Body-part scores compare your best estimated 1RM (normalized to bodyweight) against published tier thresholds from ExRx, Symmetric Strength, and Stronger By Science. DiStasio (2014) found these formulas predict actual 1RMs within 2-4% in the 3-8 rep range.
        </p>
        <p className="text-sm leading-relaxed mt-3" style={{color:'#424245'}}>
          Machine lifts are discounted before scoring (leg press ×0.45, bicep machine ×0.55, fly machine ×0.65, lat pulldown ×0.85) since the strength standards are calibrated to free-weight movements. Without this, machine numbers — which inflate due to leverage and assistance — would overstate true strength.
        </p>
      </div>

      <p className="text-center text-xs mt-2" style={{color:'#86868b'}}>Strength · v2.3 · Designed in Cupertino style</p>
    </>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-black/[0.04] last:border-0">
      <span className="text-sm" style={{color:'#1d1d1f'}}>{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}
