# DBD Build Optimizer

A **client-side** companion web app to create, refine, and share **perk builds** for *Dead by Daylight*.
Pick a role, filter by tags, **lock/ban** perks, and let the optimizer propose up to **4 perks** using **synergies** and **exclusion rules** (e.g., no double *Exhaustion*).

> **LIVE:** [https://www.dbdbuildoptimizer.com/](https://www.dbdbuildoptimizer.com/)

---

## ✨ Features

* **Zero backend** – everything runs in the browser (no login, no user uploads).
* **Multi-source dataset with cache**

  1. public APIs,
  2. fallback to `public/perks.json`,
  3. minimal embedded fallback.
     Cached in `localStorage` for **6 hours** (`dbd-api-cache-v8`).
* **Optimizer** – ranking by **tags + synergy + anti-synergy + mutex** with bonuses (tier / rate / killer focus).
* **Fast UI** – search & filters, **Lock/Ban**, dynamic suggestions.
* **Randomiser** – 4-perk random builds that respect bans/mutex/no-duplicates.
* **Image export (1200×628)** – automatic **CORS fallbacks** and proxy for perk icons.
* **Accessibility** – keyboard toggles (Enter/Space), ARIA for dialogs and hints.
* **Perfect for static hosting** – GitHub Pages / Netlify / Vercel.

---

## 🧱 Stack

* **Vite + React + TypeScript**
* **Tailwind CSS v4** (official `@tailwindcss/vite` plugin)
* **Canvas 2D** for the shareable image
* **localStorage** for settings + API cache

---

## 🔌 Data flow & cache

On load:

1. Try **cache** from `localStorage` (TTL 6h).
2. **Fetch APIs** with `cache: "no-store"`:

   * Survivor:
     `GET https://dennisreep.nl/dbd/api/v3/getSurvivorPerkData?description=true`
   * Killer:
     `GET https://dennisreep.nl/dbd/api/v3/getKillerPerkData?description=true`
3. **Killer enrichment** – for each killer owner compute `meta.topForKillers` via
   `GET .../getKillerData?killer=<slug>`.
4. If APIs fail → **fallback** to `GET /perks.json`.
5. If that fails too → use the **minimal in-code dataset**.

> To invalidate the cache, bump `API_CACHE_KEY` (current: `dbd-api-cache-v8`).

---

## 📦 Dataset (`public/perks.json`)

Expected shape:

```json
{
  "version": "2025-09-10",
  "perks": [
    {
      "id": "sprint_burst",
      "name": "Sprint Burst",
      "role": "survivor",
      "tags": ["chase", "exhaustion"],
      "synergy": ["Resilience"],
      "anti_synergy": ["Lithe", "Dead Hard", "Balanced Landing", "Overcome"],
      "desc": "Gain a burst of speed when you start running.",
      "icon": "https://.../sprint_burst.png",
      "meta": { "owner": "Meg Thomas", "tier": "A", "rate": 4.1 }
    }
  ]
}
```

**Notes**

* `synergy` / `anti_synergy` are optional; the optimizer also works with tags only.
* Some tags are **derived automatically** from name/description:

  * Survivor → `exhaustion`
  * Killer → `scourge_hook`
* For killers, when available the code augments `meta.topForKillers` as
  `[{ "slug": "<killer>", "rank": 1, "usage": 4.2 }, ...]`.

### Mutex rules (automatic exclusions)

```ts
const MUTEX_TAGS = {
  survivor: ["exhaustion"],
  killer: ["scourge_hook"]
};
```

If a picked perk contains a mutex tag, the optimizer avoids another perk with the **same** mutex tag.

---

## 🧠 Optimizer scoring (summary)

For each candidate perk:

* **Selected tags match**: **+10** per matching tag
* **Synergies (`synergy`)** with locked/current perks: **+8** each
* **Anti-synergies (`anti_synergy`)** against current perks: **−12** each
* **Mutex conflict** (same mutex tag as current): **−100** (hard avoid)
* **Tier bonus**: `S:+10, A:+6, B:+3, C:+0, D:-2, E:-4, F:-6`
* **Rate bonus**: clamp `rate` to `[0..5]`, then `(rate − 2.5) * 3`
* **Killer focus**: if enabled and present in `topForKillers`,
  `bonus = max(0, 14 - (rank - 1) * 2)` (rank 1 → +14, rank 2 → +12, …)
* **Tiny tie-breaker** favoring shorter names

The final build contains up to **4 perks**, respecting **bans**, **locks**, and **mutex**.

---

## 🧰 UI overview

* **Role switch** (Survivor / Killer)
* **Search & Filters**

  * Owner (dynamic label: Killer or Survivor), Tier, Min Rate
  * Clickable **tag chips**
* **Perk list**

  * Click to toggle description (collapsible)
  * **Lock / Ban** buttons
* **Optimizer (right column)**

  * Shows up to 4 suggestions
  * **Killer focus** (killer role only)
  * **Share build** → export PNG
* **Randomiser modal**

  * Re-roll 4-perk build by role, respects bans/mutex/no-dupes
* **Persistence** in `localStorage` (role, selected tags, locked, banned, filters)

---

## 🖼️ Image export

* Size: **1200×628**
* Flexible layout: each card’s height is **measured dynamically** (title/meta/tags) so rows align even with long titles.
* Icons: rounded-corner draw, compact size; single-line **ellipsis** for long titles/tags.
* **CORS-safe icon loading** sequence:

  1. Standard CORS `crossOrigin="anonymous"`
  2. `referrerPolicy="no-referrer"`
  3. Proxy: `https://images.weserv.nl/?url=<host/path>`
* Sharing: uses **Web Share API** with a file when available, otherwise triggers PNG **download**.

---

## 🚀 Local development

Requirements: **Node 18+**

```bash
# install dependencies
npm install

# dev server
npm run dev
```

Tailwind v4 is already configured via the Vite plugin. In your main CSS:

```css
@import "tailwindcss";
```

---

## 🛠️ Build

```bash
npm run build
```

Output goes to `dist/`.

---

## 🌐 Deploy

### Option A — GitHub Pages on `gh-pages` branch (recommended)

Add scripts to `package.json`:

```json
{
  "scripts": {
    "build": "vite build",
    "predeploy": "npm run build && node -e \"require('fs').copyFileSync('dist/index.html','dist/404.html')\"",
    "deploy": "gh-pages -d dist -b gh-pages"
  }
}
```

Then:

```bash
npm run deploy
```

GitHub **Settings → Pages**:

* **Source:** *Deploy from a branch*
* **Branch:** `gh-pages` / **root**

For a **project site** (`https://USERNAME.github.io/REPO_NAME/`), set in `vite.config.ts`:

```ts
export default defineConfig({
  base: '/REPO_NAME/',
  plugins: [react(), tailwind()]
})
```

and read the dataset with:

```ts
fetch(import.meta.env.BASE_URL + 'perks.json')
```

### Option B — Custom domain

If the site lives at the domain **root**:

* `vite.config.ts`: `base: '/'`
* dataset fetch: `fetch('/perks.json', { cache: 'no-store' })`
* Configure **Settings → Pages → Custom domain** and your **DNS**
  (CNAME `www` → `USERNAME.github.io`, A-records at apex → GitHub Pages IPs)
* Enable **Enforce HTTPS**

---

## 🔎 Troubleshooting

* **404 for `vite.svg` or `perks.json` on Pages** → usually `base` or absolute paths

  * `vite.config.ts` → `base: '/REPO_NAME/'`
  * `index.html` favicon → `href="%BASE_URL%vite.svg"`
  * fetch → `import.meta.env.BASE_URL + 'perks.json'`
* **CORS errors for icons during export**
  Normal if the host doesn’t expose CORS. The code tries **no-referrer** and then uses **images.weserv.nl** as a proxy.
* **`Unchecked runtime.lastError` in console**
  This typically comes from a **browser extension**, not the site.
* **Empty dataset after APIs**
  The app logs a warning and falls back to `/perks.json`, then to the minimal embedded dataset.
* **Layout not centered / spacing issues**
  Outer wrapper uses `flex justify-center`, inner uses `mx-auto`.
  Tune grid gaps and paddings via Tailwind classes in JSX.

---

## 📂 Minimal project structure

```
public/
  perks.json
src/
  App.tsx
  main.tsx
  index.css                # @import "tailwindcss"
scripts/
  make_perks_from_dennisreep.mjs   # optional: dataset generation
vite.config.ts
```

### Optional: generate `perks.json` from public pages

Example script (HTML scraper with `cheerio`):

```bash
# generate/update public/perks.json
npm run make-perks
```

Configure sources in `scripts/make_perks_from_dennisreep.mjs`.
You can also maintain `perks.json` manually or from other structured sources.

---

## 🤝 Contributing

PRs and issues are welcome. If you change tags, (anti)synergies, or scoring heuristics, please include a short rationale in the PR.

---

## 📄 License

MIT — see `LICENSE`.

> *DBD Build Optimizer is a fan-made project, not affiliated with Behaviour Interactive. All trademarks and game content are property of their respective owners.*
