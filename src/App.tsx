import { useRef, useEffect, useMemo, useState } from "react";

export type Role = "survivor" | "killer";

type Perk = {
  id: string;
  name: string;
  role: Role;
  tags: string[];
  synergy?: string[];
  anti_synergy?: string[];
  desc?: string;
  rarity?: string;
  meta?: Record<string, any>;
  icon?: string | null;
};

type DbdDataset = {
  version: string;
  perks: Perk[];
};

type Settings = {
  role: Role;
  selectedTags: string[];
  locked: string[];
  banned: string[];
  search: string;
  killerFocus: string;
  filterOwner: string;
  filterTier: string;
  filterRateMin: string;
};

// ---- Minimal fallback dataset (only for first run / local dev)
const FALLBACK: DbdDataset = {
  version: "fallback",
  perks: [
    {
      id: "dead_hard",
      name: "Dead Hard",
      role: "survivor",
      tags: ["chase", "exhaustion"],
      synergy: ["Adrenaline", "Resilience"],
      anti_synergy: ["No Mither"],
      desc: "Dash forward to avoid a hit while exhausted.",
    },
    {
      id: "adrenaline",
      name: "Adrenaline",
      role: "survivor",
      tags: ["endgame", "heal", "speed"],
      synergy: ["Dead Hard", "Resilience"],
      desc: "On last gen completion: heal one state and gain haste.",
    },
    {
      id: "resilience",
      name: "Resilience",
      role: "survivor",
      tags: ["injured", "repair", "general"],
      synergy: ["Adrenaline", "Dead Hard"],
      desc: "Action speed bonus while injured.",
    },
    {
      id: "barbecue_and_chili",
      name: "Barbecue & Chili",
      role: "killer",
      tags: ["tracking", "economy"],
      synergy: ["Pop Goes the Weasel"],
      desc: "Auras on hook; bonus bloodpoints.",
    },
    {
      id: "pop_goes_the_weasel",
      name: "Pop Goes the Weasel",
      role: "killer",
      tags: ["gen_regression", "hook"],
      synergy: ["Barbecue & Chili", "Pain Resonance"],
      desc: "After hook: kick a gen for big regression.",
    },
    {
      id: "pain_resonance",
      name: "Scourge Hook: Pain Resonance",
      role: "killer",
      tags: ["gen_regression", "hook"],
      synergy: ["Pop Goes the Weasel"],
      desc: "Scourge hook triggers regression/explosion.",
    },
  ],
};

// ---- Local settings only (not dataset)
const SETTINGS_KEY = "dbd-build-optimizer-settings";
function useLocalStorage<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);
  return [state, setState] as const;
}

const API_BASE = "https://dennisreep.nl/dbd/api/v3";
const API_URLS = {
  survivorPerks: `${API_BASE}/getSurvivorPerkData?description=true`,
  killerPerks: `${API_BASE}/getKillerPerkData?description=true`,
  killerData: (slug: string) =>
    `${API_BASE}/getKillerData?killer=${encodeURIComponent(slug)}`,
};

const API_CACHE_KEY = "dbd-api-cache-v8"; // bump
const API_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function slugifyId(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function killerSlugFromOwner(owner: string) {
  return normalize(owner)
    .replace(/^the\s+/, "")
    .replace(/\s+/g, "");
}

function normalize(str: string) {
  return str.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function deriveTags(role: Role, raw: any): string[] {
  const out = new Set<string>();
  if (Array.isArray(raw.tags))
    raw.tags.forEach((t: string) => out.add(String(t)));

  const name = String(raw.name ?? raw.perkName ?? "");
  const desc = String(raw.description ?? raw.desc ?? raw.text ?? "");

  if (role === "survivor" && /exhaust(ed|ion)/i.test(name + " " + desc))
    out.add("exhaustion");
  if (role === "killer" && /scourge\s*hook/i.test(name))
    out.add("scourge_hook");

  return Array.from(out);
}

function getPerkDescription(raw: any): string | undefined {
  const d =
    raw?.Description ??
    raw?.PerkDescription ??
    raw?.Desc ??
    raw?.Text ??
    raw?.Details ??
    null;
  return d ? cleanDescHtml(String(d)) : undefined;
}

function mapSurvivorPerk(raw: any): Perk {
  const name = String(raw.PerkName ?? raw.name ?? raw.perkName ?? "");
  const desc = getPerkDescription(raw); // 👈 pulita
  return {
    id: String(raw.id ?? slugifyId(name)),
    name,
    role: "survivor",
    tags: deriveTags("survivor", { name, description: desc ?? "" }),
    desc,
    icon: raw.Image ? String(raw.Image).trim() : null,
    meta: {
      owner: raw.Survivor ?? undefined,
      tier: raw.Tier ?? undefined,
      rate: typeof raw.Rating === "number" ? raw.Rating : undefined,
    },
  };
}

function mapKillerPerk(raw: any): Perk {
  const name = String(
    raw.PerkName ?? raw.name ?? raw.Perk ?? raw.perkName ?? ""
  ).trim();
  const desc = getPerkDescription(raw);
  const iconRaw = raw.PerkIcon ?? raw.Image ?? raw.Icon ?? null;

  return {
    id: String(raw.id ?? slugifyId(name)),
    name,
    role: "killer",
    tags: deriveTags("killer", { name, description: desc ?? "" }),
    desc,
    icon: iconRaw ? String(iconRaw).trim() : null,
    meta: {
      owner:
        raw.PerkKiller ??
        raw.Killer ??
        raw.KillerName ??
        raw.Owner ??
        undefined,
      tier: raw.Tier ?? undefined,
      rate:
        typeof raw.Rating === "number"
          ? raw.Rating
          : typeof raw.rate === "number"
          ? raw.rate
          : undefined,
    },
  };
}

function stripPatchNotices(text: string): string {
  if (!text) return "";

  const lines = text.split(/\n+/);
  const keep = lines.filter((rawLine) => {
    const line = rawLine.trim().replace(/\s+/g, " ");

    const isNotice =
      /^(“|"|')?\s*(this|the)\s+description\b/i.test(line) &&
      /(patch|ptb)/i.test(line);

    const isAltNotice =
      /^information\s+in\s+(this\s+)?(article|description)\b.*(patch|ptb)/i.test(
        line
      ) || /^subject\s+to\s+change\b.*(patch|ptb)/i.test(line);

    return !(isNotice || isAltNotice);
  });

  let out = keep.join("\n\n");

  out = out.replace(
    /\(\s*(?:this|the)\s+description\b[\s\S]*?(?:patch|ptb)[\s\S]*?\)/gim,
    ""
  );

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanDescHtml(html: string): string {
  if (!html) return "";
  try {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;

    wrap
      .querySelectorAll(
        '.iconLink, .pcView, .mobileView, .tooltip, .tooltiptext, .tooltipBaseText, .tooltipTextWrapper, [typeof="mw:File"]'
      )
      .forEach((el) => el.remove());

    wrap.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    wrap.querySelectorAll("p").forEach((p, i) => {
      if (i > 0) p.insertAdjacentText("beforebegin", "\n\n");
    });

    let text = (wrap.textContent || "").replace(/\u00A0/g, " ");
    text = stripPatchNotices(text);
    return text;
  } catch {
    return stripPatchNotices(
      html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\u00A0/g, " ")
        .trim()
    );
  }
}

function dedupeByName(perks: Perk[]) {
  const seen = new Set<string>();
  const out: Perk[] = [];
  for (const p of perks) {
    const key = normalize(p.name);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

type KillerTopPerk = { name: string; rank?: number; usage?: number };

function extractTopPerksFromKillerData(raw: any): KillerTopPerk[] {
  const list: any[] = Array.isArray(raw?.Killers)
    ? raw.Killers
    : Array.isArray(raw)
    ? raw
    : [];

  return list
    .map(
      (x: any, i: number): KillerTopPerk => ({
        name: String(x?.PerkName ?? x?.name ?? x?.perk ?? x?.perkName ?? ""),
        rank: Number(x?.rank ?? x?.position ?? i + 1) || i + 1,
        usage:
          typeof x?.Rating === "number"
            ? x.Rating
            : typeof x?.rate === "number"
            ? x.rate
            : undefined,
      })
    )
    .filter((r: KillerTopPerk) => Boolean(r.name));
}

async function fetchKillerDataForSlugs(slugs: string[]) {
  type KillerTopPerk = { name: string; rank?: number; usage?: number };
  const results: Record<string, KillerTopPerk[]> = {};

  await Promise.all(
    slugs.map(async (slug) => {
      try {
        const res = await fetch(API_URLS.killerData(slug), {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("not ok");
        const json = await res.json();
        results[slug] = extractTopPerksFromKillerData(json);
      } catch {}
    })
  );
  return results;
}

const TIER_BONUS: Record<string, number> = {
  S: 10,
  A: 6,
  B: 3,
  C: 0,
  D: -2,
  E: -4,
  F: -6,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function getRate(p: Perk): number | null {
  const r = (p.meta as any)?.rate;
  if (typeof r === "number") return r;
  if (typeof r === "string") {
    const n = parseFloat(r.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function rateBonus(p: Perk) {
  const r = getRate(p);
  if (r == null) return 0;
  const rr = clamp(r, 0, 5);
  return (rr - 2.5) * 3;
}

function tierBonus(p: Perk) {
  const raw = (p.meta as any)?.tier;
  const key = typeof raw === "string" ? raw.toUpperCase() : "";
  return key in TIER_BONUS ? TIER_BONUS[key] : 0;
}

function killerFocusBonus(p: Perk, slug: string | undefined | null): number {
  if (!slug) return 0;
  const arr = (p.meta as any)?.topForKillers;
  if (!Array.isArray(arr)) return 0;
  const hit = arr.find((x: any) => x?.slug === slug);
  if (!hit) return 0;
  const rank = Number(hit.rank ?? 99);
  return Math.max(0, 14 - (rank - 1) * 2);
}

function scorePerk(
  p: Perk,
  ctx: {
    role: Role;
    tags: string[];
    locked: string[];
    banned: string[];
    current: Perk[];
    killerFocus?: string;
  }
) {
  if (p.role !== ctx.role) return -9999;
  if (
    ctx.banned.some(
      (b) =>
        normalize(b) === normalize(p.name) || normalize(b) === normalize(p.id)
    )
  )
    return -9999;

  let score = 0;

  for (const t of ctx.tags)
    if (p.tags.map(normalize).includes(normalize(t))) score += 10;

  const related = new Set((p.synergy || []).map(normalize));
  const lockedNames = ctx.locked.map((n) => normalize(n));
  const currentNames = ctx.current.map((c) => normalize(c.name));
  for (const n of [...lockedNames, ...currentNames])
    if (related.has(n)) score += 8;

  const anti = new Set((p.anti_synergy || []).map(normalize));
  for (const n of currentNames) if (anti.has(n)) score -= 12;

  const mutex = new Set((MUTEX_TAGS[p.role] || []).map(normalize));
  const pTags = new Set(p.tags.map(normalize));
  const hasMutexTag = [...pTags].some((t) => mutex.has(t));
  if (hasMutexTag) {
    const currentHasSameMutex = ctx.current.some((c) =>
      c.tags.map(normalize).some((t) => pTags.has(t) && mutex.has(t))
    );
    if (currentHasSameMutex) score -= 100;
  }

  score += tierBonus(p);
  score += rateBonus(p);

  score += killerFocusBonus(p, ctx.killerFocus);

  score += (100 - Math.min(100, p.name.length)) * 0.01;

  return score;
}

const MUTEX_TAGS: Record<Role, string[]> = {
  survivor: ["exhaustion"],
  killer: ["scourge_hook"],
};

function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPadRight = body.style.paddingRight;

    const scrollbarW = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarW > 0) body.style.paddingRight = `${scrollbarW}px`;

    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadRight;
    };
  }, [locked]);
}

function LoadingOverlay({ show }: { show: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={show}
      aria-hidden={!show}
      className={`fixed inset-0 z-[60] bg-black flex items-center justify-center
                  transition-opacity duration-300
                  ${
                    show
                      ? "opacity-100 pointer-events-auto"
                      : "opacity-0 pointer-events-none"
                  }`}
    >
      <img src="/loader.gif" alt="" className="h-50 w-50" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

// ---- Share utilities (canvas)

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
) {
  const words = (text || "").split(/\s+/);
  let line = "";
  let lineCount = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + " " + words[i] : words[i];
    const m = ctx.measureText(test);
    if (m.width > maxWidth && i > 0) {
      ctx.fillText(line, x, y);
      line = words[i];
      y += lineHeight;
      lineCount++;
      if (lineCount >= maxLines - 1) {
        // ultima riga con ellissi
        let clipped = "";
        for (let j = i; j < words.length; j++) {
          const next = (clipped ? clipped + " " : "") + words[j];
          if (ctx.measureText(next + "…").width > maxWidth) break;
          clipped = next;
        }
        ctx.fillText(clipped + "…", x, y);
        return;
      }
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function loadImageExt(url: string, useCors: boolean, referrer?: RequestCredentials | "no-referrer") {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    if (useCors) img.crossOrigin = "anonymous";
    if (referrer) (img as any).referrerPolicy = referrer; // "no-referrer"
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("img load failed"));
    img.src = url;
  });
}

const ICON_PROXY_BASE = "https://images.weserv.nl/?url=";
// converte https://host/path.png -> https://images.weserv.nl/?url=host/path.png
function proxify(url: string) {
  try {
    const u = new URL(url);
    const noProto = u.host + u.pathname + (u.search || "");
    return ICON_PROXY_BASE + encodeURIComponent(noProto);
  } catch {
    return url;
  }
}

async function tryLoadIcon(url?: string | null): Promise<HTMLImageElement | null> {
  if (!url) return null;
  // 1) CORS “normale”
  try { return await loadImageExt(url, true); } catch {}
  // 2) Senza referrer
  try { return await loadImageExt(url, true, "no-referrer"); } catch {}
  // 3) Proxy pubblico (o rimpiazza con il tuo)
  try { return await loadImageExt(proxify(url), true); } catch {}
  return null; // niente icona -> disegna solo testo
}


type DrawIconResult = { ok: boolean };

function drawPerkCard(
  ctx: CanvasRenderingContext2D,
  perk: Perk,
  icon: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number
): DrawIconResult {
  // card bg
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = "#1b1b1b";
  ctx.fill();

  // border
  ctx.strokeStyle = "rgba(255,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const pad = 14;
  const iconSize = 170;
  let left = x + pad;
  let top = y + pad;

  // Icona (se disponibile)
  if (icon) {
    roundRect(ctx, left, top, iconSize, iconSize, 10);
    ctx.save();
    ctx.clip();
    ctx.drawImage(icon, left, top, iconSize, iconSize);
    ctx.restore();

    // piccola cornice sull’icona
    ctx.strokeStyle = "rgba(255,0,0,0.2)";
    ctx.lineWidth = 1;
    roundRect(ctx, left, top, iconSize, iconSize, 10);
    ctx.stroke();

    left += iconSize + 16; // testo a destra dell’icona
  }

  // Titolo
  ctx.fillStyle = "#fff";
  ctx.font =
    "700 26px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  wrapText(ctx, perk.name, left, top + 26, w - (left - x) - pad, 28, 2);

  // Tier / Rate
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font =
    "500 18px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  const r = getRate(perk);
  const tier = perk.meta?.tier ? `Tier: ${perk.meta.tier}` : "";
  const rate = r != null ? `Rate: ${r.toFixed(1)}` : "";
  const mid = [tier, rate].filter(Boolean).join(" · ");
  if (mid) ctx.fillText(mid, left, top + 26 + 28 + 8);

  // Role + Owner
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font =
    "500 16px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  const ro = perk.role + (perk.meta?.owner ? ` · ${perk.meta.owner}` : "");
  ctx.fillText(ro, left, top + 26 + 28 + 8 + 24);

  // Tags
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font =
    "500 16px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
  const tags = (perk.tags || []).join(" · ");
  const tagsY = top + 26 + 28 + 8 + 24 + 24;
  wrapText(ctx, tags, left, tagsY, w - (left - x) - pad, 20, 2);

  return { ok: !!icon };
}

export default function App() {
  const MIN_BOOT_MS = 2350;
  const [booting, setBooting] = useState(true);
  const [minElapsed, setMinElapsed] = useState(false);
  const [dataset, setDataset] = useState<DbdDataset | null>(null);
  const [randOpen, setRandOpen] = useState(false);
  const [randRole, setRandRole] = useState<Role>("survivor");
  const [randBuild, setRandBuild] = useState<Perk[]>([]);
  const [settings, setSettings] = useLocalStorage<Settings>(SETTINGS_KEY, {
    role: "survivor" as Role,
    selectedTags: [],
    locked: [] as string[],
    banned: [] as string[],
    search: "",
    killerFocus: "" as string,
    filterOwner: "" as string,
    filterTier: "" as string,
    filterRateMin: "" as string,
  });

  const appShellRef = useRef<HTMLDivElement>(null);

  const isBannedPerk = (p: Perk) =>
    settings.banned.some(
      (b) =>
        normalize(b) === normalize(p.name) || normalize(b) === normalize(p.id)
    );

  function hasMutexConflict(candidate: Perk, picked: Perk[]) {
    const mutex = new Set((MUTEX_TAGS[candidate.role] || []).map(normalize));
    const cTags = new Set(candidate.tags.map(normalize));
    const candidateHasMutex = [...cTags].some((t) => mutex.has(t));
    if (!candidateHasMutex) return false;
    return picked.some((x) =>
      x.tags.map(normalize).some((t) => cTags.has(t) && mutex.has(t))
    );
  }

  function shuffle<T>(arr: T[]) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function makeRandomBuild(role: Role) {
    const pool = dedupeByName(
      perks.filter((p) => p.role === role && !isBannedPerk(p))
    );
    const rnd = shuffle(pool);

    const chosen: Perk[] = [];
    for (const p of rnd) {
      if (chosen.length >= 4) break;
      if (hasMutexConflict(p, chosen)) continue;
      if (chosen.some((c) => normalize(c.name) === normalize(p.name))) continue;
      chosen.push(p);
    }

    if (chosen.length < 4) {
      for (const p of rnd) {
        if (chosen.length >= 4) break;
        if (chosen.some((c) => normalize(c.name) === normalize(p.name)))
          continue;
        chosen.push(p);
      }
    }
    return chosen.slice(0, 4);
  }

  const openerRef = useRef<HTMLButtonElement | null>(null);

  function openRandomiser(e?: React.MouseEvent<HTMLButtonElement>) {
    openerRef.current = e?.currentTarget ?? null;
    const startRole = settings.role;
    setRandRole(startRole);
    setRandBuild(makeRandomBuild(startRole));
    setRandOpen(true);
  }

  function closeRandomiser() {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setRandOpen(false);
    setTimeout(() => openerRef.current?.focus(), 0);
  }

  function pickRandomFor(role: Role) {
    setRandRole(role);
    setRandBuild(makeRandomBuild(role));
  }

  useScrollLock(booting);
  useEffect(() => {
    const n = appShellRef.current;
    if (!n) return;
    if (booting) n.setAttribute("inert", "");
    else n.removeAttribute("inert");
  }, [booting]);

  useEffect(() => {
    if (!randOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRandomiser();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [randOpen]);

  useEffect(() => {
    if (!randOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [randOpen]);

  function readCache(): DbdDataset | null {
    try {
      const raw = localStorage.getItem(API_CACHE_KEY);
      if (!raw) return null;
      const { savedAt, dataset } = JSON.parse(raw);
      if (Date.now() - Number(savedAt) > API_TTL_MS) return null;
      return dataset as DbdDataset;
    } catch {
      return null;
    }
  }
  function writeCache(dataset: DbdDataset) {
    try {
      localStorage.setItem(
        API_CACHE_KEY,
        JSON.stringify({ savedAt: Date.now(), dataset })
      );
    } catch {}
  }

  function asArray(x: any): any[] {
    return Array.isArray(x) ? x : [];
  }

  function pickFirstArray(...candidates: any[]): any[] {
    for (const c of candidates) if (Array.isArray(c)) return c;
    return [];
  }

  async function fetchDatasetFromAPI(): Promise<DbdDataset> {
    const [sRes, kRes] = await Promise.all([
      fetch(API_URLS.survivorPerks, { cache: "no-store", mode: "cors" }),
      fetch(API_URLS.killerPerks, { cache: "no-store", mode: "cors" }),
    ]);
    if (!sRes.ok || !kRes.ok) throw new Error("API not ok");

    const sJson = await sRes.json();
    const kJson = await kRes.json();

    const sArr = pickFirstArray(sJson?.Perks, sJson?.data, sJson?.items, sJson);

    console.log(
      "[DBD] killer JSON keys:",
      kJson && typeof kJson === "object" ? Object.keys(kJson) : "(non-object)"
    );
    console.log(
      "[DBD] sample killer row:",
      Array.isArray(kJson?.Killers)
        ? kJson.Killers[0]
        : Array.isArray(kJson?.Perks)
        ? kJson.Perks[0]
        : Array.isArray(kJson?.data)
        ? kJson.data[0]
        : Array.isArray(kJson)
        ? kJson[0]
        : null
    );

    const kArr = pickFirstArray(
      kJson?.Killers,
      kJson?.Perks,
      kJson?.perks,
      kJson?.data,
      kJson?.items,
      Array.isArray(kJson) ? kJson : undefined
    );

    const survivorPerks = asArray(sArr)
      .map(mapSurvivorPerk)
      .filter((p) => p.name);
    const killerPerks = asArray(kArr)
      .map(mapKillerPerk)
      .filter((p) => p.name);
    const perks: Perk[] = [...survivorPerks, ...killerPerks];

    if (perks.length === 0) {
      console.warn(
        "[DBD] APIs responded but without perks (shape not recognised or empty). Forcing fallback."
      );
      throw new Error("EMPTY_DATASET");
    }

    const killerOwners = Array.from(
      new Set(
        killerPerks.map((p: Perk) => p.meta?.owner).filter(Boolean) as string[]
      )
    );
    const killerSlugs = killerOwners.map(killerSlugFromOwner);

    const kdMap = await fetchKillerDataForSlugs(killerSlugs);

    const indexByName: Record<string, Perk> = {};
    for (const p of perks) indexByName[normalize(p.name)] = p;

    for (const [slug, list] of Object.entries(kdMap)) {
      list.forEach((row) => {
        const key = normalize(row.name);
        const perk = indexByName[key];
        if (!perk) return;
        const prev = (perk.meta as any)?.topForKillers || [];
        perk.meta = {
          ...(perk.meta || {}),
          topForKillers: [...prev, { slug, rank: row.rank, usage: row.usage }],
        };
      });
    }

    console.log(
      `[DBD] Loaded perks: survivors=${survivorPerks.length}, killers=${killerPerks.length}`
    );
    return {
      version: `${new Date().toISOString().slice(0, 10)}`,
      perks,
    };
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cached = readCache();
        if (cached) {
          if (alive) setDataset(cached);
        } else {
          const ds = await fetchDatasetFromAPI();
          if (alive) {
            setDataset(ds);
            writeCache(ds);
          }
        }
      } catch {
        try {
          const res = await fetch("/perks.json", { cache: "no-store" });
          if (!res.ok) throw new Error("perks.json not found");
          const json = (await res.json()) as DbdDataset;
          if (alive) setDataset(json);
        } catch {
          if (alive) setDataset(FALLBACK);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const perks = dataset?.perks ?? FALLBACK.perks;

  console.log("[DBD] counts", {
    all: perks.length,
    survivors: perks.filter((p) => p.role === "survivor").length,
    killers: perks.filter((p) => p.role === "killer").length,
  });

  function prettyKiller(slug: string) {
    const spaced = slug
      .replace(/^the[_-]?/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    return spaced
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  const killerOptions = useMemo(() => {
    const s = new Set<string>();
    perks.forEach((p: Perk) => {
      const arr = (p.meta as any)?.topForKillers;
      if (Array.isArray(arr))
        arr.forEach((e: any) => e?.slug && s.add(String(e.slug)));
    });
    return Array.from(s).sort();
  }, [perks]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    perks
      .filter((p) => p.role === settings.role)
      .forEach((p) => p.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [perks, settings.role]);

  const visiblePerks = useMemo(() => {
    const q = normalize(settings.search);

    const ownersForRole = new Set(
      perks
        .filter((p) => p.role === settings.role)
        .map((p) => (p.meta as any)?.owner)
        .filter(Boolean) as string[]
    );
    const ownerActive =
      !!settings.filterOwner &&
      Array.from(ownersForRole).some(
        (o) => normalize(o) === normalize(settings.filterOwner)
      );

    const activeTags = settings.selectedTags.filter((t) => allTags.includes(t));

    const tierActive = !!settings.filterTier;
    const rateMin =
      settings.filterRateMin && !isNaN(Number(settings.filterRateMin))
        ? Number(settings.filterRateMin)
        : null;

    return perks.filter((p: Perk) => {
      if (p.role !== settings.role) return false;

      if (q) {
        const hay = `${p.name} ${p.tags.join(" ")} ${
          (p.meta as any)?.owner ?? ""
        } ${(p.meta as any)?.tier ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (activeTags.length > 0) {
        const perkTagsNorm = p.tags.map(normalize);
        const anyMatch = activeTags.some((t) =>
          perkTagsNorm.includes(normalize(t))
        );
        if (!anyMatch) return false;
      }

      if (ownerActive) {
        const owner = ((p.meta as any)?.owner ?? "").toString();
        if (normalize(owner) !== normalize(settings.filterOwner)) return false;
      }

      if (tierActive) {
        const tier = ((p.meta as any)?.tier ?? "").toString().toUpperCase();
        if (tier !== settings.filterTier.toUpperCase()) return false;
      }

      if (rateMin !== null) {
        const r = getRate(p);
        if (r == null || r < rateMin) return false;
      }

      return true;
    });
  }, [
    perks,
    settings.role,
    settings.search,
    JSON.stringify(settings.selectedTags),
    settings.filterOwner,
    settings.filterTier,
    settings.filterRateMin,
    JSON.stringify(allTags),
  ]);

  const [suggested, setSuggested] = useState<Perk[]>([]);
  const runOptimize = () => {
    const isBanned = (x: Perk | string) => {
      const name = typeof x === "string" ? x : x.name;
      const id = typeof x === "string" ? x : x.id;
      return settings.banned.some(
        (b) =>
          normalize(b) === normalize(name) || normalize(b) === normalize(id)
      );
    };

    const lockedPerks = perks.filter(
      (p) =>
        settings.locked.some(
          (n) =>
            normalize(n) === normalize(p.name) ||
            normalize(n) === normalize(p.id)
        ) && !isBanned(p)
    );

    let chosen: Perk[] = dedupeByName(lockedPerks).slice(0, 4);
    if (chosen.length >= 4) {
      setSuggested(chosen.slice(0, 4));
      return;
    }

    const pool = perks
      .filter((p) => p.role === settings.role)
      .filter(
        (p) => !chosen.some((c) => normalize(c.name) === normalize(p.name))
      )
      .filter((p) => !isBanned(p))
      .slice();

    while (chosen.length < 4 && pool.length) {
      pool.sort(
        (a, b) =>
          scorePerk(b, {
            role: settings.role,
            tags: settings.selectedTags,
            locked: settings.locked,
            banned: settings.banned,
            current: chosen,
            killerFocus: settings.killerFocus,
          }) -
          scorePerk(a, {
            role: settings.role,
            tags: settings.selectedTags,
            locked: settings.locked,
            banned: settings.banned,
            current: chosen,
            killerFocus: settings.killerFocus,
          })
      );

      const pick = pool.shift()!;
      if (
        scorePerk(pick, {
          role: settings.role,
          tags: settings.selectedTags,
          locked: settings.locked,
          banned: settings.banned,
          current: chosen,
          killerFocus: settings.killerFocus,
        }) > -9999
      ) {
        chosen.push(pick);
      }
    }

    setSuggested(chosen.slice(0, 4));
  };

  useEffect(() => {
    runOptimize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(perks),
    settings.role,
    JSON.stringify(settings.selectedTags),
    JSON.stringify(settings.locked),
    JSON.stringify(settings.banned),
    settings.killerFocus,
  ]);

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_BOOT_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (dataset !== null && minElapsed) setBooting(false);
  }, [dataset, minElapsed]);

  useEffect(() => {
    setSettings((s) => ({
      ...s,
      search: "",
      selectedTags: [],
      filterOwner: "",
      filterTier: "",
      filterRateMin: "",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.role]);

  const [sharing, setSharing] = useState(false);

  async function shareSuggestedAsImage() {
    if (!suggested.length || sharing) return;
    setSharing(true);
    try {
      const width = 1200;
      const height = 628;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      // sfondo
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, "#0c0c0c");
      g.addColorStop(1, "#141414");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);

      // titolo
      ctx.fillStyle = "#ffffff";
      ctx.font =
        "700 40px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
      const title = `DBD Build • ${
        settings.role === "killer" ? "Killer" : "Survivor"
      }`;
      ctx.fillText(title, 40, 70);

      // sottotitolo (data + versione)
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font =
        "500 18px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
      const sub = `${new Date().toLocaleDateString()} • dataset: ${
        dataset?.version ?? "fallback"
      }`;
      ctx.fillText(sub, 40, 100);

      // carica icone (best-effort, con fallback)
      const top4 = suggested.slice(0, 4);
      const icons = await Promise.all(top4.map((p) => tryLoadIcon(p.icon)));

      // griglia 2x2
      const cardW = 520;
      const cardH = 200;
      const slot = [
        [40, 140],
        [640, 140],
        [40, 360],
        [640, 360],
      ] as const;

      for (let i = 0; i < top4.length; i++) {
        const p = top4[i];
        const icon = icons[i];
        drawPerkCard(ctx, p, icon, slot[i][0], slot[i][1], cardW, cardH);
      }

      // watermark
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font =
        "600 16px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
      ctx.fillText("dbd-build-optimizer", 40, height - 28);

      // salva
      const blob: Blob = await new Promise((res) =>
        canvas.toBlob((b) => res(b as Blob), "image/png", 1)
      );

      // Web Share se disponibile, altrimenti download
      const file = new File([blob], `dbd-build-${settings.role}.png`, {
        type: "image/png",
      });

      if (
        (navigator as any).canShare?.({ files: [file] }) &&
        (navigator as any).share
      ) {
        await (navigator as any).share({
          files: [file],
          title: "DBD Build",
          text: "My optimized build",
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `dbd-build-${settings.role}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("[share] export failed", err);
      alert(
        "Impossibile creare l’immagine. Prova a rigenerare o riprovare più tardi."
      );
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100 px-4 py-6 flex justify-center">
      <div
        ref={appShellRef}
        className="w-full max-w-none mx-auto px-4 py-6 space-y-6"
      >
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div>
            <h1 className="!text-xl lg:!text-3xl font-semibold tracking-tight leading-tight">
              DBD Build Optimizer
            </h1>
            <p className="text-zinc-400 text-sm">Version: {__APP_VERSION__}</p>

            {/* Role under the mobile version */}
            <div className="mt-2 md:hidden flex flex-col gap-2">
              <a
                href="https://github.com/Joolace/dbd-reshade"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 px-3 py-2 rounded-xl rainbow text-black font-medium
               border border-red-900/40 hover:brightness-110 active:brightness-95
               focus:outline-none focus:ring-2 focus:ring-red-600/40"
                title="Open DBD Reshade on GitHub"
              >
                DBDReshade
              </a>

              <button
                onClick={() =>
                  setSettings({
                    ...settings,
                    role: settings.role === "survivor" ? "killer" : "survivor",
                  })
                }
                className="flex-1 px-3 py-2 rounded-xl bg-red-700/20 hover:bg-red-700/30 border border-red-900/40 text-sm"
              >
                Role:{" "}
                <span className="font-semibold ml-1">
                  {settings.role === "survivor" ? "Survivor" : "Killer"}
                </span>
              </button>

              {/* NEW */}
              <button
                onClick={(e) => openRandomiser(e)}
                className="flex-1 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-red-900/40 text-sm"
              >
                Randomiser
              </button>
            </div>
          </div>

          {/* Role on the right on desktop */}
          <div className="hidden md:flex gap-2">
            <a
              href="https://github.com/Joolace/dbd-reshade"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-xl rainbow text-black font-medium
               border border-red-900/40 hover:brightness-110 active:brightness-95
               focus:outline-none focus:ring-2 focus:ring-red-600/40"
              title="Open DBD Reshade on GitHub"
            >
              DBDReshade
            </a>

            <button
              onClick={() =>
                setSettings({
                  ...settings,
                  role: settings.role === "survivor" ? "killer" : "survivor",
                })
              }
              className="px-3 py-2 rounded-xl bg-red-700/20 hover:bg-red-700/30 border border-red-900/40 text-sm"
            >
              Role:{" "}
              <span className="font-semibold ml-1">
                {settings.role === "survivor" ? "Survivor" : "Killer"}
              </span>
            </button>

            {/* NEW: desktop */}
            <button
              onClick={(e) => openRandomiser(e)}
              className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-red-900/40 text-sm"
            >
              Perk Randomiser
            </button>
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="order-2 lg:order-1 lg:col-span-2 lg:col-start-1 space-y-4">
            <div className="flex items-center gap-2">
              <input
                placeholder="Find perk..."
                value={settings.search}
                onChange={(e) =>
                  setSettings({ ...settings, search: e.target.value })
                }
                className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-zinc-900 border border-red-900/40 outline-none focus:ring-2 focus:ring-red-700/40"
              />
              <button
                onClick={() =>
                  setSettings({
                    ...settings,
                    search: "",
                    selectedTags: [] as string[],
                    filterOwner: "",
                    filterTier: "",
                    filterRateMin: "",
                  })
                }
                className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm whitespace-nowrap shrink-0"
              >
                Reset filters
              </button>
            </div>

            {/* Advanced filters (left column) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {/* Owner (dynamic label) */}
              <div>
                <label className="text-xs text-zinc-400 block mb-1">
                  {settings.role === "killer" ? "Killer" : "Survivor"}
                </label>
                <select
                  value={settings.filterOwner}
                  onChange={(e) =>
                    setSettings({ ...settings, filterOwner: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-red-900/40 outline-none"
                >
                  <option value="">(any)</option>
                  {Array.from(
                    new Set(
                      perks
                        .filter((p) => p.role === settings.role)
                        .map((p) => (p.meta as any)?.owner)
                        .filter(Boolean) as string[]
                    )
                  )
                    .sort((a, b) => a.localeCompare(b))
                    .map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                </select>
              </div>

              {/* Tier */}
              <div>
                <label className="text-xs text-zinc-400 block mb-1">Tier</label>
                <select
                  value={settings.filterTier}
                  onChange={(e) =>
                    setSettings({ ...settings, filterTier: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-red-900/40 outline-none"
                >
                  <option value="">(any)</option>
                  {["S", "A", "B", "C", "D", "E", "F"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              {/* Min Rate */}
              <div>
                <label className="text-xs text-zinc-400 block mb-1">
                  Min rate
                </label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  step={0.1}
                  placeholder="e.g. 3.5"
                  value={settings.filterRateMin}
                  onChange={(e) =>
                    setSettings({ ...settings, filterRateMin: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-red-900/40 outline-none"
                />
              </div>
            </div>

            {/* Tags filter */}
            <div className="flex flex-wrap gap-2">
              {allTags.map((t) => {
                const active = settings.selectedTags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => {
                      const sel = active
                        ? settings.selectedTags.filter((x: string) => x !== t)
                        : [...settings.selectedTags, t];
                      setSettings({ ...settings, selectedTags: sel });
                    }}
                    className={`px-3 py-1 rounded-full border text-sm ${
                      active
                        ? "bg-red-600 text-white border-red-600"
                        : "bg-black border-red-900/40 text-zinc-300 hover:bg-zinc-900"
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>

            {/* Perk list */}
            <div className="grid sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {visiblePerks.map((p: Perk) => (
                <PerkCard
                  key={p.id}
                  perk={p}
                  onLock={() =>
                    setSettings((prev) => ({
                      ...prev,
                      locked: Array.from(new Set([...prev.locked, p.name])),
                      banned: prev.banned.filter(
                        (i) =>
                          normalize(i) !== normalize(p.name) &&
                          normalize(i) !== normalize(p.id)
                      ),
                    }))
                  }
                  onBan={() =>
                    setSettings((prev) => ({
                      ...prev,
                      banned: Array.from(new Set([...prev.banned, p.name])),
                      locked: prev.locked.filter(
                        (i) =>
                          normalize(i) !== normalize(p.name) &&
                          normalize(i) !== normalize(p.id)
                      ),
                    }))
                  }
                />
              ))}
            </div>
          </div>

          {/* Right column: Optimizer */}
          <aside className="order-1 lg:order-2 lg:col-start-3 lg:row-start-1 space-y-4">
            <div className="p-4 rounded-2xl bg-zinc-900 border border-red-900/40 xl:sticky xl:top-4">
              <h2 className="font-semibold mb-2">Optimizer</h2>
              <p className="text-sm text-zinc-400 mb-3">
                Block or ban perks, choose tags, then generate. The algorithm
                suggests up to 4 synergistic perks.
              </p>

              {settings.role === "killer" && (
                <div className="mb-3">
                  <label className="text-xs text-zinc-400 block mb-1">
                    Killer focus
                  </label>
                  <select
                    value={settings.killerFocus}
                    onChange={(e) =>
                      setSettings({ ...settings, killerFocus: e.target.value })
                    }
                    className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-red-900/40 outline-none"
                  >
                    <option value="">(none)</option>
                    {killerOptions.map((slug) => (
                      <option key={slug} value={slug}>
                        {prettyKiller(slug)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="mb-3">
                <label className="text-xs text-zinc-400">Locked</label>
                <TokenList
                  items={settings.locked}
                  onRemove={(x) =>
                    setSettings({
                      ...settings,
                      locked: settings.locked.filter((i: string) => i !== x),
                    })
                  }
                />
              </div>

              <div className="mb-3">
                <label className="text-xs text-zinc-400">Banned</label>
                <TokenList
                  items={settings.banned}
                  onRemove={(x) =>
                    setSettings({
                      ...settings,
                      banned: settings.banned.filter((i: string) => i !== x),
                    })
                  }
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    /* recompute */ setTimeout(runOptimize, 0);
                  }}
                  className="flex-1 px-3 py-2 rounded-xl bg-red-900 text-white font-medium hover:bg-red-500"
                >
                  Generate build
                </button>

                <button
                  onClick={shareSuggestedAsImage}
                  disabled={!suggested.length || sharing}
                  className={`px-3 py-2 rounded-xl border border-red-900/40
                ${
                  !suggested.length || sharing
                    ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : "bg-zinc-800 hover:bg-zinc-700 text-white"
                }`}
                  title={
                    !suggested.length
                      ? "Nessun perk suggerito da esportare"
                      : "Crea immagine condivisibile"
                  }
                >
                  {sharing ? "Exporting…" : "Share build"}
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3">
                {suggested.map((p: Perk) => (
                  <SuggestedPerkCard
                    key={p.id}
                    perk={p}
                    onLock={() =>
                      setSettings((prev) => ({
                        ...prev,
                        locked: Array.from(new Set([...prev.locked, p.name])),
                        banned: prev.banned.filter(
                          (i) =>
                            normalize(i) !== normalize(p.name) &&
                            normalize(i) !== normalize(p.id)
                        ),
                      }))
                    }
                    onBan={() =>
                      setSettings((prev) => ({
                        ...prev,
                        banned: Array.from(new Set([...prev.banned, p.name])),
                        locked: prev.locked.filter(
                          (i) =>
                            normalize(i) !== normalize(p.name) &&
                            normalize(i) !== normalize(p.id)
                        ),
                      }))
                    }
                  />
                ))}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-zinc-900 border border-red-900/40">
              <h3 className="font-semibold mb-2">Dataset</h3>
              <p className="text-sm text-zinc-400 mb-3">
                The data is updated and created with the{" "}
                <a href="https://dennisreep.nl/" target="_blank">
                  dennisreep.nl
                </a>
                . This tool is still under development, so you may encounter
                bugs, data errors, etc.{" "}
              </p>
              <p className="text-xs text-zinc-400">
                Developed by{" "}
                <a href="https://github.com/Joolace/" target="_blank">
                  Joolace
                </a>
              </p>
            </div>
          </aside>
        </section>

        <footer className="text-center text-xs text-zinc-500 pt-4 border-t border-neutral-900">
          <p className="inline-flex items-center gap-2">
            <span>{dataset?.version ?? "fallback"}</span>
            <span aria-hidden>·</span>
            <a href="/privacy.html" className="underline hover:text-zinc-300">
              Privacy Policy
            </a>
          </p>
        </footer>
      </div>
      <FloatingBugButton href="https://discord.gg/mC7Eabu3QW" />
      <LoadingOverlay show={booting} />
      <RandomiserModal
        show={randOpen}
        onClose={closeRandomiser}
        role={randRole}
        build={randBuild}
        onPickRole={(r) => pickRandomFor(r)}
        onReroll={() => setRandBuild(makeRandomBuild(randRole))}
      />
    </div>
  );
}

function PerkCard({
  perk,
  onLock,
  onBan,
}: {
  perk: Perk;
  onLock: () => void;
  onBan: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasRate =
    typeof perk.meta?.rate !== "undefined" && perk.meta?.rate !== null;

  const toggle = () => setOpen((v) => !v);
  const descId = `perk-desc-${perk.id}`;

  return (
    <div
      className={`p-3 rounded-2xl bg-zinc-900 border transition
                  ${
                    open
                      ? "border-red-600/60"
                      : "border-red-900/40 hover:border-red-700/50"
                  }`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls={perk.desc ? descId : undefined}
      title={
        perk.desc
          ? open
            ? "Click again to hide"
            : "Click to see the description"
          : undefined
      }
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Icon */}
          {perk.icon && (
            <img
              src={perk.icon}
              alt={perk.name}
              className="w-16 h-16 mb-2 rounded-lg border border-red-900/40 object-contain bg-black/40"
              loading="lazy"
              decoding="async"
            />
          )}

          {/* Name */}
          <div className="font-medium">{perk.name}</div>

          {/* Tier / Rate */}
          <div className="text-xs text-zinc-300">
            {perk.meta?.tier && (
              <>
                Tier: {perk.meta.tier}
                {hasRate ? " · " : ""}
              </>
            )}{" "}
            {hasRate &&
              (() => {
                const r = getRate(perk);
                return r != null ? <>Rate: {r.toFixed(1)}</> : null;
              })()}
          </div>

          {/* Role + Owner */}
          <div className="text-xs text-zinc-300 capitalize">
            {perk.role}
            {perk.meta?.owner && (
              <>
                {" "}
                · <span className="normal-case">{perk.meta.owner}</span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLock();
            }}
            className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700"
          >
            Lock
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBan();
            }}
            className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700"
          >
            Ban
          </button>
        </div>
      </div>

      {/* Tag */}
      {perk.tags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {perk.tags.map((t) => (
            <span
              key={t}
              className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 border border-red-900/40 text-zinc-200"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Hint */}
      {perk.desc && (
        <div className="mt-2 text-[11px] text-zinc-400/90 italic select-none flex items-center gap-1">
          {open ? "Click again to hide" : "Click to see the description"}
          <span
            aria-hidden
            className={`inline-block transition-transform ${
              open ? "rotate-180" : ""
            }`}
          >
            ▾
          </span>
        </div>
      )}

      {/* Desc: === true */}
      {open && perk.desc && (
        <p
          id={descId}
          className="text-xs text-zinc-400 mt-2 whitespace-pre-line"
        >
          {perk.desc}
        </p>
      )}
    </div>
  );
}

function SuggestedPerkCard({
  perk,
  onLock,
  onBan,
}: {
  perk: Perk;
  onLock: () => void;
  onBan: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasRate =
    typeof perk.meta?.rate !== "undefined" && perk.meta?.rate !== null;

  const toggle = () => setOpen((v) => !v);
  const descId = `opt-desc-${perk.id}`;

  return (
    <div
      className={`p-3 rounded-xl bg-zinc-800 border transition
                  ${
                    open
                      ? "border-red-600/60"
                      : "border-red-900/40 hover:border-red-700/50"
                  }`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls={perk.desc ? descId : undefined}
      title={
        perk.desc
          ? open
            ? "Click again to hide"
            : "Click to see the description"
          : undefined
      }
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <div className="flex items-center">
        {/* Icon */}
        {perk.icon && (
          <img
            src={perk.icon}
            alt={perk.name}
            className="w-16 h-16 mr-3 mb-2 rounded border border-red-900/40 bg-black/40"
          />
        )}

        {/* Buttons */}
        <div className="ml-auto flex gap-2 shrink-0">
          <button
            className="text-xs px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-700 border border-red-900/40"
            onClick={(e) => {
              e.stopPropagation();
              onLock();
            }}
            type="button"
          >
            Lock
          </button>
          <button
            className="text-xs px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-700 border border-red-900/40"
            onClick={(e) => {
              e.stopPropagation();
              onBan();
            }}
            type="button"
          >
            Ban
          </button>
        </div>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <div className="font-medium">{perk.name}</div>

          {/* Tier / Rate */}
          <div className="text-xs text-zinc-300">
            {perk.meta?.tier && (
              <>
                Tier: {perk.meta.tier}
                {hasRate ? " · " : ""}
              </>
            )}
            {hasRate &&
              (() => {
                const r = getRate(perk);
                return r != null ? <>Rate: {r.toFixed(1)}</> : null;
              })()}
          </div>

          {/* Role + Owner */}
          <div className="text-xs text-zinc-300 capitalize">
            {perk.role}
            {perk.meta?.owner && (
              <>
                {" "}
                · <span className="normal-case">{perk.meta.owner}</span>
              </>
            )}
          </div>

          {/* Tag */}
          <div className="text-xs text-zinc-300">{perk.tags.join(" · ")}</div>
        </div>
      </div>

      {/* Sinergy */}
      {perk.synergy && perk.synergy.length > 0 && (
        <div className="text-xs text-zinc-300 mt-1">
          Sinergie: {perk.synergy.join(", ")}
        </div>
      )}

      {/* Hint */}
      {perk.desc && (
        <div className="mt-2 text-[11px] text-zinc-400/90 italic select-none flex items-center gap-1">
          {open ? "Click again to hide" : "Click to see the description"}
          <span
            aria-hidden
            className={`inline-block transition-transform ${
              open ? "rotate-180" : ""
            }`}
          >
            ▾
          </span>
        </div>
      )}

      {/* Descrizione a toggle */}
      {open && perk.desc && (
        <p
          id={descId}
          className="text-xs text-zinc-400 mt-1 whitespace-pre-line"
        >
          {perk.desc}
        </p>
      )}
    </div>
  );
}

function TokenList({
  items,
  onRemove,
}: {
  items: string[];
  onRemove: (x: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.length === 0 && (
        <div className="text-xs text-zinc-500">(empty)</div>
      )}
      {items.map((x) => (
        <span
          key={x}
          className="text-xs px-2 py-1 rounded-full bg-zinc-800 border border-red-900/40"
        >
          {x}
          <button
            onClick={() => onRemove(x)}
            className="ml-2 text-zinc-300 hover:text-white"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function FloatingBugButton({ href }: { href: string }) {
  return (
    <div className="group fixed bottom-4 right-4 z-50">
      {/* Tooltip bubble (desktop) */}
      <div className="pointer-events-none absolute right-14 bottom-1/2 translate-y-1/2 hidden md:block">
        <div
          role="tooltip"
          className="whitespace-nowrap rounded-lg bg-zinc-900 border border-red-900/40 text-white text-sm px-3 py-1.5
                     opacity-0 translate-x-2 group-hover:opacity-100 group-hover:translate-x-0
                     group-focus-within:opacity-100 group-focus-within:translate-x-0 transition"
        >
          Report a bug
        </div>
      </div>

      {/* Round button */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Report a bug"
        title="Report a bug"
        className="flex h-12 w-12 items-center justify-center rounded-full
                   bg-white hover:bg-zinc-100 active:bg-zinc-200
                   text-black shadow-lg shadow-black/20 border border-zinc-300
                   focus:outline-none focus:ring-2 focus:ring-red-600/50"
      >
        <span className="text-xl" aria-hidden>
          🐞
        </span>
      </a>
    </div>
  );
}

function RandomiserModal({
  show,
  onClose,
  role,
  build,
  onPickRole,
  onReroll,
}: {
  show: boolean;
  onClose: () => void;
  role: Role;
  build: Perk[];
  onPickRole: (r: Role) => void;
  onReroll: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const n = rootRef.current;
    if (!n) return;
    if (!show) n.setAttribute("inert", "");
    else n.removeAttribute("inert");
  }, [show]);

  useEffect(() => {
    if (!show) return;
    rootRef.current?.querySelector<HTMLButtonElement>("[data-close]")?.focus();
  }, [show]);

  return (
    <div
      ref={rootRef}
      className={`fixed inset-0 z-[70] ${show ? "" : "pointer-events-none"}`}
      {...(show
        ? {
            role: "dialog",
            "aria-modal": true as const,
            "aria-labelledby": "rand-title",
          }
        : { "aria-hidden": true as const })}
    >
      {/* backdrop */}
      <div
        className={`absolute inset-0 bg-black/70 transition-opacity duration-200 ${
          show ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      {/* dialog */}
      <div
        className={`absolute inset-0 flex items-center justify-center p-4 transition-transform duration-200 ${
          show ? "scale-100 opacity-100" : "scale-95 opacity-0"
        }`}
      >
        <div className="w-full max-w-3xl rounded-2xl bg-zinc-950 border border-red-900/40 p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 id="rand-title" className="text-lg font-semibold">
              Perk Randomiser
            </h3>
            <button
              data-close
              onClick={onClose}
              className="px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-red-900/40 text-sm"
            >
              Close
            </button>
          </div>

          {/* role switch */}
          <div className="mb-4 flex items-center gap-2">
            <span className="text-xs text-zinc-400">Role:</span>
            <button
              onClick={() => onPickRole("survivor")}
              className={`px-3 py-1.5 rounded-xl border text-sm ${
                role === "survivor"
                  ? "bg-red-600 text-white border-red-600"
                  : "bg-zinc-900 hover:bg-zinc-800 border-red-900/40"
              }`}
            >
              Survivor
            </button>
            <button
              onClick={() => onPickRole("killer")}
              className={`px-3 py-1.5 rounded-xl border text-sm ${
                role === "killer"
                  ? "bg-red-600 text-white border-red-600"
                  : "bg-zinc-900 hover:bg-zinc-800 border-red-900/40"
              }`}
            >
              Killer
            </button>

            <div className="ml-auto">
              <button
                onClick={onReroll}
                className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-red-900/40 text-sm"
              >
                Reroll
              </button>
            </div>
          </div>

          {/* build grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {build.map((p: Perk) => (
              <div
                key={p.id}
                className="p-3 rounded-xl bg-zinc-900 border border-red-900/40 flex items-center gap-3"
              >
                {p.icon ? (
                  <img
                    src={p.icon}
                    alt=""
                    className="w-16 h-16 rounded-lg border border-red-900/40 object-contain bg-black/40"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-lg border border-red-900/40 bg-black/40 flex items-center justify-center text-xs text-zinc-400">
                    no icon
                  </div>
                )}
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-zinc-400 capitalize">
                    {p.role}
                  </div>
                  {p.meta?.owner && (
                    <div className="text-xs text-zinc-400 normal-case">
                      {p.meta.owner}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-4 text-[11px] text-zinc-500">
            The build avoids duplicates and respects mutex tags (e.g. only one
            Exhaustion/Scourge Hook). Banned perks are excluded.
          </p>
        </div>
      </div>
    </div>
  );
}
