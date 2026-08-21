import React, { useState, useMemo, useEffect, useRef } from 'react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, BarChart, Bar, Cell } from 'recharts';
import { Zap, Flame, BarChart3, Settings, Sparkles, Minus, Plus, RotateCcw, Eye, X, Camera, Trash2, History as HistoryIcon, ChevronDown, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
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
  history: 'weight-history',
  bodyweight: 'bodyweight',
  sex: 'sex',
  birthdate: 'birthdate',
  avatar: 'avatar',
};

// Default birthdate: Feb 25, 2000 (yields age 26 in 2026)
const DEFAULT_BIRTHDATE = '2000-02-25';

// Compute age in years from a YYYY-MM-DD birthdate string
const ageFromBirthdate = (bd) => {
  if (!bd) return null;
  const birth = new Date(bd + 'T00:00:00');
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
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

// ============================================================
// LIFT LIBRARY
// ============================================================
// One entry per movement — no duplicates. Baselines are the working
// weights recorded 2026-08-21. Trailing "s" means per-side (e.g. "70s"
// = 70 lb dumbbells in each hand), which doubles the load before scoring.
//
// Consolidated from the older session logs:
//   - RDL + DB RDL          → DB RDL (dumbbells are what actually gets used)
//   - Goblet Squat + Heel elevated Goblet Squat → Front Squat
//   - Single Arm row        → merged into Single arm DB row
//   - Chest Machine barbell → merged into Chest press barbell
//   - 2/3 squat             → dropped (was already excluded from rotation)
// ============================================================
const BASELINE_DATE = '2026-08-21';

const RAW_LOWER = `Seated leg press 375
Linear hack press 180s
Hack Squat [hack slide] (3 x 8-10) - 140s
Front Squat (3 x 8-10) - 125
Split Squat (3 x 8) - 70s
Leg curl (3 x 10-12) - 170
Single hamstring roll outs (3 x 6-8) - body weight
DB RDL (3 x 8-12) - 70s
Goodmorning (3 x 8-10) - 80`;

const RAW_UPPER = `T bar row (3 x 8-10) - 135
Cable row (3 x 8-12) - 140
Single arm DB row (3 x 8-10) - 65
Standing Lat Pulldown (3 x 8-10) - 150
Chest press barbell (3 x 8-10) - 160
Incline press barbell 140
Pectoral fly machine 150
DB fly (3 x 8-10) - 55s
Machine dips (3 x 8-12) - 165
Side raises (3 x 8-10) - 20s
Leaning side raise (3 x 8) - 20
Full ROM Side raises (3 x 8-12) - 20s
Tricep press down (3 x 8-10) - 70
Skull Crusher (3 x 8-10) - 30s
Db hammer curls (3 x 8-12) - 35s
Bicep curl machine 130`;

const RAW = RAW_LOWER + '\n' + RAW_UPPER;

// Normalize names so "T bar row" and "t bar row" merge
const nameKey = (n) => n.toLowerCase().replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();

// The library is already deduplicated, so the pool is a straight parse.
// A defensive dedupe stays in place in case a duplicate line is ever added.
const EXERCISE_POOL = (() => {
  const map = {};
  RAW.split('\n').map(parseSet).filter(Boolean).forEach(ex => {
    const key = nameKey(ex.name);
    if (!map[key]) map[key] = ex;
  });
  return Object.values(map);
})();

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
  'front squat': { primary: 'quads', body: 'lower' },
  'hack': { primary: 'quads', body: 'lower' },
  'leg press': { primary: 'quads', body: 'lower' },
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

// Male strength standards (lbs/bodyweight ratios for major lifts)
// Sources: ExRx norms, Symmetric Strength dataset, Stronger By Science
const STANDARDS_M = {
  chest: { novice: 0.75, intermediate: 1.10, advanced: 1.50, elite: 1.90 },
  back: { novice: 0.65, intermediate: 1.00, advanced: 1.40, elite: 1.80 },
  quads: { novice: 0.90, intermediate: 1.40, advanced: 1.90, elite: 2.40 },
  hamstrings: { novice: 0.80, intermediate: 1.25, advanced: 1.70, elite: 2.20 },
  shoulders: { novice: 0.45, intermediate: 0.70, advanced: 0.95, elite: 1.20 },
  triceps: { novice: 0.30, intermediate: 0.50, advanced: 0.70, elite: 0.95 },
  biceps: { novice: 0.25, intermediate: 0.40, advanced: 0.55, elite: 0.75 },
};

// Female strength standards — roughly 60-70% of male thresholds depending
// on the lift. Lower-body ratios are closer to male values than upper-body.
// Sources: same as above (ExRx, Symmetric Strength, Stronger By Science).
const STANDARDS_F = {
  chest: { novice: 0.40, intermediate: 0.65, advanced: 0.90, elite: 1.20 },
  back: { novice: 0.40, intermediate: 0.65, advanced: 0.90, elite: 1.20 },
  quads: { novice: 0.65, intermediate: 1.05, advanced: 1.50, elite: 1.90 },
  hamstrings: { novice: 0.55, intermediate: 0.90, advanced: 1.30, elite: 1.70 },
  shoulders: { novice: 0.25, intermediate: 0.40, advanced: 0.60, elite: 0.80 },
  triceps: { novice: 0.18, intermediate: 0.30, advanced: 0.45, elite: 0.65 },
  biceps: { novice: 0.15, intermediate: 0.25, advanced: 0.40, elite: 0.55 },
};

// Resolve which standards table to use based on user's sex selection
const getStandards = (sex) => (sex === 'female' ? STANDARDS_F : STANDARDS_M);

// Backwards-compat alias for the body-tier-thresholds display
const STANDARDS = STANDARDS_M;

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
  const [tab, setTab] = useState('generate');
  const [bodyweight, setBodyweight] = useState(190);
  const [sex, setSex] = useState('male');               // 'male' | 'female'
  const [birthdate, setBirthdate] = useState(DEFAULT_BIRTHDATE);
  const [avatar, setAvatar] = useState(null);           // base64 data URL or null
  // Per-exercise weight overrides keyed by nameKey.
  // When the user updates a weight on the Generate tab, we store the new
  // raw value here. bestLifts / muscleScores read overrides first, then
  // fall back to the original lift.txt values.
  const [weightOverrides, setWeightOverrides] = useState({});
  // Append-only log of every weight change, keyed by nameKey:
  //   { 't bar row': [{ weight: 140, date: '2026-08-24' }, ...] }
  // The library baseline is NOT stored here — it's prepended at render time
  // by the History tab, so resetting weights returns history to baseline too.
  const [weightHistory, setWeightHistory] = useState({});
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
      localforage.getItem(STORAGE_KEYS.sex),
      localforage.getItem(STORAGE_KEYS.birthdate),
      localforage.getItem(STORAGE_KEYS.avatar),
      localforage.getItem(STORAGE_KEYS.history),
    ]).then(([savedOverrides, savedBW, savedSex, savedBD, savedAvatar, savedHistory]) => {
      if (cancelled) return;
      if (savedOverrides && typeof savedOverrides === 'object') setWeightOverrides(savedOverrides);
      if (savedHistory && typeof savedHistory === 'object') setWeightHistory(savedHistory);
      if (typeof savedBW === 'number' && savedBW > 0) setBodyweight(savedBW);
      if (savedSex === 'male' || savedSex === 'female') setSex(savedSex);
      if (typeof savedBD === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(savedBD)) setBirthdate(savedBD);
      if (typeof savedAvatar === 'string' && savedAvatar.startsWith('data:')) setAvatar(savedAvatar);
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

  // Persist sex / birthdate / avatar
  useEffect(() => { if (hydrated) localforage.setItem(STORAGE_KEYS.sex, sex).catch(() => {}); }, [sex, hydrated]);
  useEffect(() => { if (hydrated) localforage.setItem(STORAGE_KEYS.birthdate, birthdate).catch(() => {}); }, [birthdate, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    if (avatar === null) localforage.removeItem(STORAGE_KEYS.avatar).catch(() => {});
    else localforage.setItem(STORAGE_KEYS.avatar, avatar).catch(() => {});
  }, [avatar, hydrated]);

  // Persist the history log on change (after hydration completes)
  useEffect(() => {
    if (!hydrated) return;
    localforage.setItem(STORAGE_KEYS.history, weightHistory).catch(() => {});
  }, [weightHistory, hydrated]);

  // Saving a weight does two things: sets the override used for scoring and
  // generation, and appends a dated entry to that lift's history. Two updates
  // on the same calendar day collapse into one — the later value wins, so the
  // log reads as "what I lifted that day" rather than every button press.
  const updateWeight = (name, newWeight) => {
    const key = nameKey(name);
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
    setWeightOverrides(prev => ({ ...prev, [key]: newWeight }));
    setWeightHistory(prev => {
      const entries = prev[key] ? [...prev[key]] : [];
      const last = entries[entries.length - 1];
      if (last && last.date === today) entries[entries.length - 1] = { weight: newWeight, date: today };
      else entries.push({ weight: newWeight, date: today });
      return { ...prev, [key]: entries };
    });
  };

  // Clearing weights clears the log too, so the two never disagree.
  const resetAllWeights = () => {
    setWeightOverrides({});
    setWeightHistory({});
  };

  const bestLifts = useMemo(() => {
    const map = {};
    EXERCISE_POOL.forEach(ex => {
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
      map[key] = {
        name: ex.name,
        e1rm: e1RM(correctedWeight, ex.reps),
        rawWeight,
        factor,
        weight: correctedWeight,
        reps: ex.reps,
        muscle: classifyExercise(ex.name)
      };
    });
    // Compute per-lift strength score (0-100) using the lift's primary muscle's
    // tier thresholds. This gives every individual lift a scored value so we
    // can rank them best→worst regardless of muscle group.
    const stds = getStandards(sex);
    return Object.values(map).map(lift => {
      const m = lift.muscle.primary;
      if (m === 'other' || !stds[m]) return { ...lift, liftScore: null };
      const ratio = lift.e1rm / bodyweight;
      const t = tierFromRatio(ratio, stds[m]);
      return { ...lift, liftScore: t.score, liftTier: t.tier, liftRatio: ratio };
    });
  }, [bodyweight, weightOverrides, sex]);

  const muscleScores = useMemo(() => {
    const stds = getStandards(sex);
    const groups = {};
    bestLifts.forEach(lift => {
      const m = lift.muscle.primary;
      if (m === 'other') return;
      const ratio = lift.e1rm / bodyweight;
      if (!groups[m]) groups[m] = [];
      groups[m].push(ratio);
    });
    const scores = {};
    for (const m of Object.keys(stds)) {
      const ratios = groups[m] || [];
      if (ratios.length === 0) { scores[m] = { score: 0, tier: 'Untested', ratio: 0 }; continue; }
      const best = Math.max(...ratios);
      const t = tierFromRatio(best, stds[m]);
      scores[m] = { ...t, ratio: best };
    }
    return scores;
  }, [bestLifts, bodyweight, sex]);

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
              <p className="text-xs font-semibold tracking-wider uppercase" style={{color:'#FF375F'}}>
                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </p>
              <h1 className="text-3xl font-bold tracking-tight" style={{color:'#1d1d1f', letterSpacing:'-0.02em'}}>
                {tab === 'generate' ? 'Generate' : tab === 'history' ? 'History' : tab === 'insights' ? 'Insights' : 'Profile'}
              </h1>
            </div>
            <button onClick={() => setTab('profile')} className="haptic w-9 h-9 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0" style={{background: avatar ? 'transparent' : 'linear-gradient(135deg,#FF375F,#FF9500)'}}>
              {avatar
                ? <img src={avatar} alt="" className="w-full h-full object-cover" />
                : <span className="text-white font-bold text-sm">{sex === 'female' ? 'SF' : 'SC'}</span>
              }
            </button>
          </div>
        </header>

        <main className="px-5 pt-3 space-y-4">
          {tab === 'generate' && <GenerateView updateWeight={updateWeight} weightOverrides={weightOverrides} workout={workout} setWorkout={setWorkout} />}
          {tab === 'history' && <HistoryView weightHistory={weightHistory} weightOverrides={weightOverrides} updateWeight={updateWeight} />}
          {tab === 'insights' && <InsightsView overall={overallScore} muscleScores={muscleScores} bestLifts={bestLifts} bodyweight={bodyweight} />}
          {tab === 'profile' && <ProfileView
            bodyweight={bodyweight} setBodyweight={setBodyweight}
            sex={sex} setSex={setSex}
            birthdate={birthdate} setBirthdate={setBirthdate}
            avatar={avatar} setAvatar={setAvatar}
            weightOverrides={weightOverrides} resetAllWeights={resetAllWeights}
            hydrated={hydrated}
          />}
        </main>

        <nav className="fixed bottom-0 left-0 right-0 glass border-t border-black/5">
          <div className="max-w-md mx-auto flex justify-around py-2 pb-6">
            {[
              { id:'generate', icon: Sparkles, label:'Generate' },
              { id:'history', icon: HistoryIcon, label:'History' },
              { id:'insights', icon: BarChart3, label:'Insights' },
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
// INSIGHTS VIEW — strength score, best/worst lifts, symmetry
// ============================================================
function InsightsView({ overall, muscleScores, bestLifts, bodyweight }) {
  const tier = overall >= 75 ? 'Advanced' : overall >= 50 ? 'Intermediate' : overall >= 25 ? 'Novice' : 'Building';
  const scoredLifts = bestLifts.filter(l => l.liftScore !== null);
  const topLifts = [...scoredLifts].sort((a,b) => b.liftScore - a.liftScore).slice(0, 3);
  const bottomLifts = [...scoredLifts].sort((a,b) => a.liftScore - b.liftScore).slice(0, 3);

  const radarData = Object.entries(muscleScores)
    .filter(([,s]) => s.score > 0)
    .map(([m, s]) => ({ muscle: m.charAt(0).toUpperCase()+m.slice(1), score: Math.round(s.score), full: 100 }));

  return (
    <>
      {/* STRENGTH SCORE */}
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

      {/* BEST / WORST LIFTS */}
      <LiftRankCard
        title="Best Lifts"
        subtitle="Your strongest movements relative to bodyweight"
        lifts={topLifts}
        accent="#34C759"
        gradient="linear-gradient(135deg,#34C759,#30D158)"
        delay={80}
        bodyweight={bodyweight}
      />

      <LiftRankCard
        title="Worst Lifts"
        subtitle="Where there's the most room to grow"
        lifts={bottomLifts}
        accent="#FF3B30"
        gradient="linear-gradient(135deg,#FF3B30,#FF453A)"
        delay={140}
        bodyweight={bodyweight}
      />

      {/* SYMMETRY PROFILE */}
      <div className="card p-5" style={{animationDelay:'200ms'}}>
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

      {/* SCORE BY BODY PART */}
      <div className="card p-5" style={{animationDelay:'260ms'}}>
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

      <div className="card p-5" style={{animationDelay:'320ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Exercise Library</p>
        <p className="text-2xl font-bold" style={{color:'#1d1d1f'}}>{EXERCISE_POOL.length}<span className="text-sm font-normal ml-1" style={{color:'#86868b'}}>movements tracked</span></p>
        <p className="text-sm mt-2" style={{color:'#424245'}}>
          {EXERCISE_POOL.filter(e => classifyExercise(e.name).body === 'upper').length} upper · {EXERCISE_POOL.filter(e => classifyExercise(e.name).body === 'lower').length} lower
        </p>
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
// The library is now deduplicated at the source, so nothing needs banning.
// Kept as an escape hatch for pulling a lift out of rotation (injury, gym
// doesn't have the machine) without deleting its history.
const BANNED_EXERCISES = new Set([]);

// Mutual-exclusion groups: if any member is already picked, all others
// in the same group are blocked for the rest of that session.
const EXCLUSION_GROUPS = [
  ['single arm db row', 'cable row'],
  ['db fly', 'pectoral fly machine'],
  ['chest press barbell', 'incline press barbell'],
  ['side raises', 'leaning side raise', 'full rom side raises'],
  ['db hammer curls', 'bicep curl machine'],
  ['tricep press down', 'skull crusher'],
  ['front squat', 'split squat'],
  ['hack squat', 'linear hack press', 'seated leg press'],
  ['db rdl', 'goodmorning'],
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

// Weight increment matched to the load: plates get bigger as the bar does.
// Shared by the Generate tab and the History tab so both steppers agree.
const stepFor = (w) => (w >= 100 ? 5 : w >= 25 ? 2.5 : 1);

function ExerciseCard({ ex, idx, onUpdate, onSave }) {
  const [showDiagram, setShowDiagram] = useState(false);
  const bodyColor = ex.body === 'upper' ? '#FF375F' : '#FF9500';
  const stepWeight = stepFor(ex.workingWeight);
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
  { test: n => /front squat/i.test(n), key: 'frontsquat' },
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
  frontsquat: {
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
        {/* elbows driven high, bar racked across the front delts */}
        <Line x1={100} y1={72} x2={82} y2={78} />
        <Line x1={82} y1={78} x2={88} y2={64} />
        <Line x1={100} y1={72} x2={118} y2={78} />
        <Line x1={118} y1={78} x2={112} y2={64} />
        <Barbell x1={70} y1={70} x2={130} y2={70} color={c} />
        <Arrow x={155} y={70} dy={70} color={c} />
      </StickPerson>
    ),
    howTo: 'Rack the bar across your front delts and collarbone, elbows driven high and forward. Squat down with your torso upright, keeping the elbows up so the bar stays put. Drive through your midfoot to stand.'
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
// HISTORY VIEW — per-exercise weight log
// ============================================================
// Upper body listed first, alphabetical within each group. Every lift
// starts with its library baseline; each saved update on the Generate
// tab appends a dated entry on top of it.

const fmtWeight = (w, ex) => {
  if (ex.isBodyweight) return 'BW';
  return ex.perSide ? `${w} lb/side` : `${w} lb`;
};

const fmtDate = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Builds [{ weight, date, isBaseline, delta }] oldest → newest for one lift
const buildTimeline = (ex, entries) => {
  const timeline = [{ weight: ex.weight, date: BASELINE_DATE, isBaseline: true, delta: 0 }];
  (entries || []).forEach(e => {
    const prev = timeline[timeline.length - 1];
    timeline.push({ weight: e.weight, date: e.date, isBaseline: false, delta: +(e.weight - prev.weight).toFixed(2) });
  });
  return timeline;
};

function HistoryView({ weightHistory, weightOverrides, updateWeight }) {
  const groups = useMemo(() => {
    const build = (body) => EXERCISE_POOL
      .filter(ex => classifyExercise(ex.name).body === body)
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      .map(ex => {
        const key = nameKey(ex.name);
        const timeline = buildTimeline(ex, weightHistory[key]);
        const current = weightOverrides[key] !== undefined ? weightOverrides[key] : ex.weight;
        return { ex, key, timeline, current, updates: timeline.length - 1 };
      });
    return { upper: build('upper'), lower: build('lower') };
  }, [weightHistory, weightOverrides]);

  const totalUpdates = [...groups.upper, ...groups.lower].reduce((n, g) => n + g.updates, 0);

  return (
    <>
      <div className="card p-5" style={{animationDelay:'0ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'#86868b'}}>Weight Log</p>
        <p className="text-2xl font-bold mt-0.5" style={{color:'#1d1d1f', letterSpacing:'-0.02em'}}>
          {totalUpdates}<span className="text-base font-normal ml-1.5" style={{color:'#86868b'}}>{totalUpdates === 1 ? 'update' : 'updates'} logged</span>
        </p>
        <p className="text-sm mt-2 leading-relaxed" style={{color:'#424245'}}>
          {totalUpdates === 0
            ? `Every lift is sitting at its baseline from ${fmtDate(BASELINE_DATE)}. Save a new weight on the Generate tab and it'll show up here.`
            : 'Tap any lift to see how its weight has moved over time.'}
        </p>
      </div>

      <HistorySection title="Upper Body" accent="#FF375F" rows={groups.upper} startDelay={60} updateWeight={updateWeight} />
      <HistorySection title="Lower Body" accent="#FF9500" rows={groups.lower} startDelay={120} updateWeight={updateWeight} />
    </>
  );
}

function HistorySection({ title, accent, rows, startDelay, updateWeight }) {
  if (!rows.length) return null;
  return (
    <div className="card overflow-hidden" style={{animationDelay:`${startDelay}ms`}}>
      <div className="px-5 pt-4 pb-2 flex items-center gap-2.5">
        <div className="w-1 h-4 rounded-full" style={{background: accent}} />
        <p className="text-xs font-bold uppercase tracking-widest" style={{color: accent}}>{title}</p>
        <span className="text-xs tabular-nums ml-auto" style={{color:'#86868b'}}>{rows.length}</span>
      </div>
      <div>
        {rows.map(row => <HistoryRow key={row.key} row={row} accent={accent} updateWeight={updateWeight} />)}
      </div>
    </div>
  );
}

// Inline weight editor shown when a history row is expanded. Writes through
// the same updateWeight() the Generate tab uses, so a change made here lands
// in the log with today's date exactly like one saved mid-workout.
function HistoryWeightEditor({ ex, current, accent, updateWeight }) {
  const [draft, setDraft] = useState(current);

  // Follow the stored value if it changes elsewhere (a save on the Generate
  // tab, or Reset all weights) so the stepper never shows a stale number.
  useEffect(() => { setDraft(current); }, [current]);

  if (ex.isBodyweight) {
    return (
      <div className="rounded-2xl p-3 text-center" style={{background:'#F5F5F7'}}>
        <p className="text-[10px] font-semibold uppercase tracking-wide" style={{color:'#86868b'}}>Weight</p>
        <p className="text-base font-bold mt-1" style={{color:'#1d1d1f'}}>BW</p>
        <p className="text-xs mt-1" style={{color:'#86868b'}}>Bodyweight movement — nothing to log</p>
      </div>
    );
  }

  const step = stepFor(draft);
  const adjust = (delta) => setDraft(Math.max(0, +(draft + delta).toFixed(2)));
  const isDirty = draft !== current;

  return (
    <div className="flex items-stretch gap-2">
      <div className="flex-1">
        <Stepper
          label="Weight"
          value={draft}
          unit={ex.perSide ? 'lb/side' : 'lb'}
          onMinus={() => adjust(-step)}
          onPlus={() => adjust(step)}
          color={accent}
        />
      </div>
      <button
        onClick={() => updateWeight(ex.name, draft)}
        disabled={!isDirty}
        className="haptic px-4 rounded-2xl text-sm font-semibold flex-shrink-0 transition-all"
        style={{
          background: isDirty ? accent : '#F5F5F7',
          color: isDirty ? 'white' : '#C7C7CC',
          cursor: isDirty ? 'pointer' : 'default',
          boxShadow: isDirty ? `0 2px 8px ${accent}40` : 'none',
        }}
      >
        Save
      </button>
    </div>
  );
}

function HistoryRow({ row, accent, updateWeight }) {
  const [open, setOpen] = useState(false);
  const { ex, timeline, current, updates } = row;
  const netDelta = +(current - ex.weight).toFixed(2);

  return (
    <div className="border-t border-black/[0.04]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-3 flex items-center gap-3 text-left haptic"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{color:'#1d1d1f'}}>{ex.name}</p>
          <p className="text-xs mt-0.5" style={{color:'#86868b'}}>
            {updates === 0 ? 'Baseline only' : `${updates} ${updates === 1 ? 'update' : 'updates'} · since ${fmtDate(BASELINE_DATE)}`}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-sm font-bold tabular-nums" style={{color:'#1d1d1f'}}>{fmtWeight(current, ex)}</p>
          {netDelta !== 0 && (
            <p className="text-xs font-semibold tabular-nums flex items-center justify-end gap-0.5" style={{color: netDelta > 0 ? '#34C759' : '#FF3B30'}}>
              {netDelta > 0 ? <TrendingUp size={11} strokeWidth={2.5} /> : <TrendingDown size={11} strokeWidth={2.5} />}
              {netDelta > 0 ? '+' : ''}{netDelta}
            </p>
          )}
        </div>
        <ChevronDown
          size={16}
          color="#C7C7CC"
          strokeWidth={2.5}
          className="flex-shrink-0"
          style={{transform: open ? 'rotate(180deg)' : 'none', transition:'transform 0.2s ease'}}
        />
      </button>

      {open && (
        <div className="px-5 pb-4" style={{animation:'fadeUp 0.25s ease both'}}>
          <HistoryWeightEditor ex={ex} current={current} accent={accent} updateWeight={updateWeight} />
          <p className="text-[10px] font-bold uppercase tracking-widest mt-4 mb-2" style={{color:'#86868b'}}>Timeline</p>
          <div className="pl-1">
          {/* newest first so the most recent weight reads at the top */}
          {[...timeline].reverse().map((entry, i) => (
            <div key={i} className="flex items-start gap-3 relative pb-3 last:pb-0">
              <div className="flex flex-col items-center flex-shrink-0" style={{width:'10px'}}>
                <div className="w-2.5 h-2.5 rounded-full mt-1.5" style={{
                  background: entry.isBaseline ? '#C7C7CC' : accent,
                  boxShadow: entry.isBaseline ? 'none' : `0 0 0 3px ${accent}22`,
                }} />
                {i < timeline.length - 1 && <div className="flex-1 w-px mt-1" style={{background:'#E5E5EA', minHeight:'18px'}} />}
              </div>
              <div className="flex-1 min-w-0 flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold tabular-nums" style={{color:'#1d1d1f'}}>{fmtWeight(entry.weight, ex)}</p>
                  <p className="text-xs" style={{color:'#86868b'}}>
                    {fmtDate(entry.date)}{entry.isBaseline ? ' · baseline' : ''}
                  </p>
                </div>
                {!entry.isBaseline && entry.delta !== 0 && (
                  <span className="text-xs font-semibold tabular-nums flex-shrink-0" style={{color: entry.delta > 0 ? '#34C759' : '#FF3B30'}}>
                    {entry.delta > 0 ? '+' : ''}{entry.delta}
                  </span>
                )}
              </div>
            </div>
          ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PROFILE VIEW
// ============================================================
function ProfileView({ bodyweight, setBodyweight, sex, setSex, birthdate, setBirthdate, avatar, setAvatar, weightOverrides, resetAllWeights, hydrated }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const fileInputRef = useRef(null);
  const overrideCount = Object.keys(weightOverrides || {}).length;
  const age = ageFromBirthdate(birthdate);

  const reset = () => {
    resetAllWeights();
    setConfirmReset(false);
  };

  // Handle avatar upload: read file, resize to a square 240×240 thumbnail
  // via canvas to keep storage small (avoids blowing past IndexedDB quotas).
  const handleAvatarUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    if (!file.type.startsWith('image/')) {
      setUploadError('Please choose an image file');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        // Center-crop to square, scale to 240×240, JPEG-encode at 0.85 quality
        const size = 240;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setAvatar(dataUrl);
      };
      img.onerror = () => setUploadError('Could not decode that image');
      img.src = ev.target.result;
    };
    reader.onerror = () => setUploadError('Could not read the file');
    reader.readAsDataURL(file);
  };

  return (
    <>
      {/* AVATAR CARD */}
      <div className="card p-5 flex items-center gap-4" style={{animationDelay:'0ms'}}>
        <div className="relative">
          <div className="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center" style={{background: avatar ? 'transparent' : 'linear-gradient(135deg,#FF375F,#FF9500)'}}>
            {avatar
              ? <img src={avatar} alt="Profile" className="w-full h-full object-cover" />
              : <Camera size={28} color="white" strokeWidth={2} />
            }
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'#86868b'}}>Profile Picture</p>
          <p className="text-sm mt-0.5" style={{color:'#86868b'}}>{avatar ? 'Tap to change' : 'Upload a selfie'}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => fileInputRef.current?.click()} className="haptic px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1" style={{background:'#F5F5F7', color:'#FF375F'}}>
              <Camera size={12} strokeWidth={2.5} /> {avatar ? 'Change' : 'Upload'}
            </button>
            {avatar && (
              <button onClick={() => setAvatar(null)} className="haptic px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1" style={{background:'#F5F5F7', color:'#86868b'}}>
                <Trash2 size={12} strokeWidth={2.5} /> Remove
              </button>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
          {uploadError && <p className="text-xs mt-1.5" style={{color:'#FF3B30'}}>{uploadError}</p>}
        </div>
      </div>

      {/* PROFILE FIELDS */}
      <div className="card p-5" style={{animationDelay:'60ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Profile</p>
        <Row label="Body Weight">
          <input type="number" value={bodyweight} onChange={e=>setBodyweight(parseFloat(e.target.value)||190)} className="w-20 text-right tabular-nums font-medium bg-transparent outline-none" style={{color:'#FF375F'}} />
          <span className="text-sm ml-1" style={{color:'#86868b'}}>lb</span>
        </Row>
        <Row label="Sex">
          <SegmentedControl
            value={sex}
            onChange={setSex}
            options={[{value:'male', label:'Male'}, {value:'female', label:'Female'}]}
          />
        </Row>
        <Row label="Birthday">
          <input type="date" value={birthdate} onChange={e=>setBirthdate(e.target.value || DEFAULT_BIRTHDATE)} max={new Date().toISOString().slice(0,10)}
            className="text-right tabular-nums font-medium bg-transparent outline-none" style={{color:'#FF375F', fontSize:'14px'}} />
        </Row>
        <Row label="Age"><span className="text-sm tabular-nums" style={{color:'#86868b'}}>{age != null ? age : '—'}</span></Row>
        <Row label="Units"><span className="text-sm" style={{color:'#86868b'}}>Imperial</span></Row>
      </div>

      <div className="card p-5" style={{animationDelay:'120ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{color:'#86868b'}}>Storage</p>
        <Row label="Status">
          <span className="text-xs px-2 py-0.5 rounded-full" style={{background: hydrated?'#E8F8EE':'#FFF8E7', color: hydrated?'#34C759':'#8A6800'}}>
            {hydrated ? 'IndexedDB · synced' : 'Loading…'}
          </span>
        </Row>
        <Row label="Saved Overrides">
          <span className="text-sm tabular-nums" style={{color:'#86868b'}}>{overrideCount} {overrideCount === 1 ? 'lift' : 'lifts'}</span>
        </Row>
        <button onClick={() => setConfirmReset(true)} disabled={overrideCount === 0}
          className="haptic w-full mt-3 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{background: overrideCount > 0 ? '#F5F5F7' : '#FAFAFA', color: overrideCount > 0 ? '#FF3B30' : '#C7C7CC'}}>
          Reset all weights
        </button>
        <p className="text-xs mt-3 leading-relaxed" style={{color:'#86868b'}}>
          Weight updates, profile fields, and your photo are saved in your browser's IndexedDB and persist across sessions. Reset reverts all weights back to their original library values and clears the history log.
        </p>
      </div>

      <div className="card p-5" style={{animationDelay:'180ms'}}>
        <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{color:'#86868b'}}>The Science</p>
        <p className="text-sm leading-relaxed mb-2" style={{color:'#424245'}}>
          Strength scores use the average of two validated 1RM equations:
        </p>
        <div className="space-y-1.5 ml-2">
          <p className="text-xs" style={{color:'#86868b'}}>• <strong style={{color:'#1d1d1f'}}>Epley (1985)</strong>: 1RM = w × (1 + r/30)</p>
          <p className="text-xs" style={{color:'#86868b'}}>• <strong style={{color:'#1d1d1f'}}>Brzycki (1993)</strong>: 1RM = w × 36/(37 − r)</p>
        </div>
        <p className="text-sm leading-relaxed mt-3" style={{color:'#424245'}}>
          Body-part scores compare your best estimated 1RM (normalized to bodyweight) against published tier thresholds from ExRx, Symmetric Strength, and Stronger By Science. Standards differ by sex — female thresholds run roughly 60–70% of male thresholds across most lifts. DiStasio (2014) found these formulas predict actual 1RMs within 2–4% in the 3–8 rep range.
        </p>
        <p className="text-sm leading-relaxed mt-3" style={{color:'#424245'}}>
          Machine lifts are discounted before scoring (leg press ×0.45, bicep machine ×0.55, fly machine ×0.65, lat pulldown ×0.85) since the strength standards are calibrated to free-weight movements. Without this, machine numbers — which inflate due to leverage and assistance — would overstate true strength.
        </p>
      </div>

      <p className="text-center text-xs mt-2" style={{color:'#86868b'}}>Strength · v3.0 · Designed in Cupertino style</p>

      {confirmReset && (
        <ConfirmDialog
          title="Reset all weights?"
          body={`This clears ${overrideCount} saved ${overrideCount === 1 ? 'weight' : 'weights'} and the full history log, returning every lift to its ${fmtDate(BASELINE_DATE)} baseline. This can't be undone.`}
          confirmLabel="Reset weights"
          onConfirm={reset}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </>
  );
}

// Destructive-action confirmation. Backdrop tap and Cancel both dismiss;
// only the red button commits, so a misplaced tap can't wipe the log.
function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{background:'rgba(0,0,0,0.45)', backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)', animation:'fadeUp 0.2s ease both'}}
    >
      <div onClick={e => e.stopPropagation()} className="card w-full max-w-xs overflow-hidden" style={{animation:'fadeUp 0.25s ease both'}}>
        <div className="px-5 pt-6 pb-4 text-center">
          <div className="mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-3" style={{background:'#FFF0EF'}}>
            <AlertTriangle size={24} color="#FF3B30" strokeWidth={2.2} />
          </div>
          <h3 className="text-base font-bold" style={{color:'#1d1d1f', letterSpacing:'-0.01em'}}>{title}</h3>
          <p className="text-sm mt-1.5 leading-relaxed" style={{color:'#86868b'}}>{body}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 px-4 pb-4">
          <button onClick={onCancel} autoFocus className="haptic py-2.5 rounded-xl text-sm font-semibold" style={{background:'#F5F5F7', color:'#1d1d1f'}}>
            Cancel
          </button>
          <button onClick={onConfirm} className="haptic py-2.5 rounded-xl text-sm font-semibold text-white" style={{background:'#FF3B30', boxShadow:'0 2px 8px #FF3B3040'}}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// iOS-style segmented control: pill background with the active option
// rendered as a white-card slider sitting above the others.
function SegmentedControl({ value, onChange, options }) {
  return (
    <div className="inline-flex p-0.5 rounded-full" style={{background:'#F5F5F7'}}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className="haptic px-3 py-1 rounded-full text-xs font-semibold transition-all"
            style={{
              background: active ? 'white' : 'transparent',
              color: active ? '#1d1d1f' : '#86868b',
              boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
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
