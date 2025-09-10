# DBD Build Optimizer

A client‑side companion web app to create, refine, and share **perk builds** for *Dead by Daylight*. Users pick a role, choose style tags, lock/ban perks, and the optimizer proposes up to 4 perks using **synergy** and **mutual‑exclusion** rules (e.g., no double *Exhaustion* perks).

> **LIVE:** [DBD Build Optimizer](https://www.dbdbuildoptimizer.com/)

---

## ✨ Features
- **Read‑only dataset**: the app reads a static `perks.json` (no end‑user uploads).
- **Optimizer**: scores by tags + synergy + anti‑synergy + mutex rules (e.g., `exhaustion` and `scourge_hook`).
- **Fast UI**: filters, search, Lock/Ban, dynamic suggestions.
- **Static hosting**: perfect on GitHub Pages / Netlify / Vercel.

## 🧱 Stack
- **Vite + React + TypeScript**
- **Tailwind CSS v4** with the official `@tailwindcss/vite` plugin

---

## 🚀 Local development
Requirements: Node 18+.

```bash
# install dependencies
npm install

# start dev server
npm run dev
```

Tailwind v4 is already configured via the Vite plugin. In your main CSS:
```css
@import "tailwindcss";
```

---

## 📦 Dataset (`public/perks.json`)
The app expects a static file at `public/perks.json`:

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
      "icon": "https://.../sprint_burst.png"
    }
  ]
}
```

> **Note:** `synergy` and `anti_synergy` are optional; the optimizer also works purely with `tags`. Some incompatibilities are applied **automatically** through *mutex tags* (see below).

### Mutex (automatic rules)
The code defines **mutually exclusive** tag groups:
```ts
const MUTEX_TAGS = {
  survivor: ["exhaustion"],
  killer: ["scourge_hook"],
};
```
If a selected perk contains any mutex tag, the optimizer avoids picking a second perk with the same tag.

### Generate JSON from public pages
Scripts are included to generate/update `public/perks.json` from public pages.

Example (HTML scraper using `cheerio`):
```bash
# generate/update public/perks.json
npm run make-perks
```
Configure the scraper at `scripts/make_perks_from_dennisreep.mjs` (Killer + Survivor). You can also maintain the file manually or use other structured sources.

---

## 🛠️ Build
```bash
npm run build
```
The output is in `dist/`.

---

## 🌐 Deploy
### Option A — GitHub Pages on `gh-pages` branch (recommended)
Make sure your `package.json` has:
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
Repository → **Settings → Pages**:
- **Source:** *Deploy from a branch*
- **Branch:** `gh-pages` / **root**

> For a project site (URL `https://USERNAME.github.io/REPO_NAME/`), set in `vite.config.ts`:
> ```ts
> export default defineConfig({ base: '/REPO_NAME/', plugins: [react(), tailwind()] })
> ```
> and in code use `fetch(import.meta.env.BASE_URL + 'perks.json')`.

### Option B — Custom domain
If you serve from your own domain (site at root):
- `vite.config.ts`: `base: '/'`
- dataset fetch in code: `fetch('/perks.json', { cache: 'no-store' })`
- Configure **Settings → Pages → Custom domain** and **DNS** at your registrar (CNAME `www` → `USERNAME.github.io`, A‑records for apex → GitHub Pages IPs). Enable **Enforce HTTPS**.

---

## 🔍 Troubleshooting
- **404 for `vite.svg` or `perks.json` on Pages** → missing `base` or absolute paths.
  - `vite.config.ts` → `base: '/REPO_NAME/'`
  - `index.html` favicon → `href="%BASE_URL%vite.svg"` (or plain `vite.svg`)
  - fetch → `import.meta.env.BASE_URL + 'perks.json'`
- **TS6133 unused variables** → remove unused imports/vars or prefix with `_`.
- **Layout stuck left / not centered** → ensure outer wrapper uses `flex justify-center`, inner uses `mx-auto`; remove width limits (`max-w-*`) if you want full‑width.

---

## 📂 Minimal project structure
```
public/
  perks.json
src/
  App.tsx
  main.tsx
  index.css   # @import "tailwindcss"
scripts/
  make_perks_from_dennisreep.mjs  # optional: dataset generation
vite.config.ts
```

---

## 🤝 Contributing
PRs and issues are welcome. If you add new tags/synergy/anti‑synergy logic, please describe your approach briefly.

## 📄 License
MIT — see `LICENSE`.

> *DBD Build Optimizer is a fan‑made project, not affiliated with Behaviour Interactive. All trademarks and game content are property of their respective owners.*

