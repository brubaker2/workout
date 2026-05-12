# Strength

A personal strength tracker, built as a Progressive Web App. Inspired by Tonal and Ladder. Designed in the spirit of Apple's Human Interface Guidelines.

> Log your lifts, see your weak points, generate balanced workouts, install on your phone — no App Store required.

---

## Features

- **Strength score (0–100)** computed from your top sets across seven muscle groups, using the average of the Epley (1985) and Brzycki (1993) one-rep-max formulas — validated within 2–4% of true 1RM in the 3–8 rep range
- **Body heat map** with an interactive front-and-rear human diagram, color-coded red→orange→yellow→green by tier (Untrained / Novice / Intermediate / Advanced / Elite)
- **Best & Worst Lifts widgets** ranking your individual exercises by per-lift strength score, normalized to bodyweight against published standards (ExRx, Symmetric Strength, Stronger By Science)
- **Machine-vs-free-weight correction factors** so a 345 lb seated leg press isn't compared to a 345 lb back squat — leg press ×0.45, bicep machine ×0.55, fly machine ×0.65, lat pulldown ×0.85
- **Workout generator** that builds a balanced session in an upper / lower / upper / lower / upper / upper sequence, with mutual-exclusion groups (e.g. won't pair Goblet Squat with Heel Elevated Goblet Squat in the same session)
- **Stick-figure exercise diagrams** for every movement in the library, with a brief "How To" cue
- **Adjustable per-exercise weights** with an Update button that activates only when the value changes; saves persist via IndexedDB
- **Symmetry radar** and per-body-part bar charts on the Insights tab
- **Installable as a PWA** with offline support, custom icon, fullscreen launch, and Apple/Android home-screen integration

## Tech stack

- React 18 + Vite
- Tailwind CSS for styling
- Recharts for charts
- Lucide React for icons
- localForage (IndexedDB wrapper) for persistence
- vite-plugin-pwa for service-worker generation, manifest, and offline caching

---

## Quick start

You'll need [Node.js 18+](https://nodejs.org) installed.

```bash
git clone https://github.com/YOUR_USERNAME/strength.git
cd strength
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Production build

```bash
npm run build
npm run preview   # optional — serves the built dist/ locally to verify
```

The static site is generated in `dist/`.

---

## Deploy your own (free)

PWAs require HTTPS — the install-to-home-screen and offline features won't work without it. All three options below are free for personal use.

### Vercel (recommended, easiest)

1. Push this repo to your own GitHub account.
2. Go to [vercel.com](https://vercel.com), sign in with GitHub, click **Add New → Project**, import the repo.
3. Vercel detects Vite automatically — just click **Deploy**.

You'll get an HTTPS URL like `https://strength-yourname.vercel.app`. Every push to `main` redeploys.

### Netlify

Same flow at [netlify.com](https://netlify.com) — connect the repo, accept the auto-detected Vite settings, deploy.

### Cloudflare Pages

At [pages.cloudflare.com](https://pages.cloudflare.com): connect the repo, set build command to `npm run build`, output directory to `dist`, deploy.

---

## Add to iPhone home screen

Once deployed at an HTTPS URL:

1. Open the URL in **Safari** (Chrome on iOS won't install PWAs — must be Safari)
2. Tap the **Share** button (square with up-arrow)
3. Scroll down, tap **Add to Home Screen**
4. Confirm

The app launches fullscreen with no browser chrome, supports offline use, and saves all your data to IndexedDB.

## Add to Android home screen

Open the URL in Chrome → tap the three-dot menu → **Install app** (or "Add to Home Screen"). Same fullscreen experience, with the maskable icon adapted to whatever shape your launcher prefers.

---

## Customizing for your own data

The workout library is hardcoded in `src/App.jsx`. Find the `RAW` constant near the top — it's a multi-line string of exercises in this format:

```
Exercise Name (sets x reps[-repHigh]) - weight
```

Examples:
```
T bar row (3 x 8-10) - 115
Goblet Squat (3 x 8-10) - 75
Side raises (3 x 8-10) - 15s        # trailing "s" = per side (e.g. dumbbells)
Seated leg press 345                 # bare format → assumes 3 x 10
2/3 squat (3 x 5-6) - body weight    # bodyweight movements
```

Sequences (sessions) are separated by blank lines, but the app treats them as a single pool — order doesn't imply chronology.

To rebuild after editing: `npm run build` and redeploy.

---

## What persists, what doesn't

**Saved on device (IndexedDB via localForage):**
- Per-exercise weight overrides (every time you tap "Update")
- Body weight setting

**Not saved:**
- The currently generated workout (intentional — Generate creates fresh)
- Tab state, selected muscle, etc.

To wipe all saved weights: Profile → Storage → Reset all weights.

---

## Project layout

```
.
├── index.html              # Entry HTML with iOS PWA meta tags
├── vite.config.js          # Vite + PWA plugin config
├── tailwind.config.js
├── postcss.config.js
├── package.json
├── public/
│   ├── favicon.svg
│   ├── apple-touch-icon.png
│   ├── pwa-192.png
│   ├── pwa-512.png
│   └── pwa-512-maskable.png
├── scripts/
│   └── generate-icons.py   # Re-run to redesign the icon
└── src/
    ├── main.jsx
    ├── App.jsx             # Entire app
    └── index.css
```

---

## The science behind the scoring

Strength scores combine two validated 1RM equations:

- **Epley (1985):** 1RM = w × (1 + r/30)
- **Brzycki (1993):** 1RM = w × 36/(37 − r)

DiStasio (2014) and LeSuer & McCormick (1997) found these formulas predict actual 1RMs within 2–4% in the 3–8 rep range, with bias going opposite directions — averaging cancels individual error.

Body-part scores compare your best estimated 1RM (normalized to bodyweight) against published tier thresholds drawn from ExRx norms, the Symmetric Strength dataset, and population estimates from Greg Nuckols at Stronger By Science.

Machine lifts are discounted before scoring because the strength standards are calibrated for free-weight movements. Without correction, machine numbers would overstate true strength due to leverage, cams, and stabilization assistance. Factors are based on Schwanbeck et al. (2009) on machine-vs-free-weight EMG and Saeterbakken et al. (2011) on bench press variants.

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- Strength standards: [ExRx](https://exrx.net/), [Symmetric Strength](https://symmetricstrength.com/), [Stronger By Science](https://www.strongerbyscience.com/)
- Built with Claude (Anthropic) — entire project iterated through conversation
- Inspired by Tonal and Ladder
