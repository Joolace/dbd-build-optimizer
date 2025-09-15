import { useRef, useEffect, useMemo, useState } from "react";

/**
 * Dead by Daylight – Build Optimizer (Read‑only, production-ready MVP)
 * -------------------------------------------------------------------
 * ✅ Single-file React app that fetches a read‑only `/perks.json` at runtime
 * ✅ No import/export or dataset editing in the UI for end‑users
 * ✅ Ideal for static hosting (Vercel/Netlify/GitHub Pages)
 *
 * How it works
 * - On load, fetch(`/perks.json`) → { version, perks: [...] }
 * - If the file is missing, it falls back to a tiny built‑in seed dataset
 * - End users can solo: scegliere ruolo, filtrare, lock/ban, generare build
 */
// ---- Types
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

const API_CACHE_KEY = "dbd-api-cache-v2"; // bumpa se cambi formato cache
const API_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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

function mapSurvivorPerk(raw: any): Perk {
  const name = String(raw.name ?? raw.perkName ?? "");
  return {
    id: String(raw.id ?? slugifyId(name)),
    name,
    role: "survivor",
    tags: deriveTags("survivor", raw),
    desc: String(raw.description ?? raw.desc ?? "") || undefined,
    icon: (raw.iconUrl ?? raw.imageUrl ?? raw.icon ?? null) || null,
    meta: {
      owner: raw.owner ?? raw.character ?? raw.survivor ?? undefined,
      tier: raw.tier ?? undefined,
      rate: raw.usageRate ?? raw.rate ?? undefined,
    },
  };
}

function mapKillerPerk(raw: any): Perk {
  const name = String(raw.name ?? raw.perkName ?? "");
  return {
    id: String(raw.id ?? slugifyId(name)),
    name,
    role: "killer",
    tags: deriveTags("killer", raw),
    desc: String(raw.description ?? raw.desc ?? "") || undefined,
    icon: (raw.iconUrl ?? raw.imageUrl ?? raw.icon ?? null) || null,
    meta: {
      owner: raw.owner ?? raw.character ?? raw.killer ?? undefined,
      tier: raw.tier ?? undefined,
      rate: raw.usageRate ?? raw.rate ?? undefined,
    },
  };
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

type TopFor = { slug: string; rank?: number; usage?: number };

type KillerTopPerk = { name: string; rank?: number; usage?: number };

function extractTopPerksFromKillerData(raw: any): KillerTopPerk[] {
  const list =
    (Array.isArray(raw?.topPerks) && raw.topPerks) ||
    (Array.isArray(raw?.perks) && raw.perks) ||
    (Array.isArray(raw?.data) && raw.data) ||
    [];

  return list
    .map(
      (x: any, i: number): KillerTopPerk => ({
        name: String(x?.name ?? x?.perk ?? x?.perkName ?? ""),
        rank: Number(x?.rank ?? x?.position ?? i + 1) || i + 1,
        usage:
          typeof x?.usage === "number"
            ? x.usage
            : typeof x?.rate === "number"
            ? x.rate
            : undefined,
      })
    )
    .filter((p: KillerTopPerk) => Boolean(p.name));
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
      } catch {
        // ignora errore singolo killer
      }
    })
  );
  return results;
}

// ---- Meta scoring (Tier + Rate)
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

/** Transforms a rate of 0–5 into a bonus centred on 2.5 (range ~[-7.5, +7.5]) */
function rateBonus(p: Perk) {
  const r = getRate(p);
  if (r == null) return 0;
  const rr = clamp(r, 0, 5);
  return (rr - 2.5) * 3;
}

/** Tier score (S, A, B, ...) */
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
  // Rank 1 = +14, 2 = +12, 3 = +10 ... min 0
  return Math.max(0, 14 - (rank - 1) * 2);
}

// Basic score: match tags, add synergy, penalize anti-synergy
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

  // 1) Matches for selected tags
  for (const t of ctx.tags)
    if (p.tags.map(normalize).includes(normalize(t))) score += 10;

  // 2) Synergy bonus with locked + current selections
  const related = new Set((p.synergy || []).map(normalize));
  const lockedNames = ctx.locked.map((n) => normalize(n));
  const currentNames = ctx.current.map((c) => normalize(c.name));
  for (const n of [...lockedNames, ...currentNames])
    if (related.has(n)) score += 8;

  // 3) Declared anti-synergy penalty
  const anti = new Set((p.anti_synergy || []).map(normalize));
  for (const n of currentNames) if (anti.has(n)) score -= 12;

  // 4) Mutex rules (e.g. no double exhaustion / scourge_hook)
  const mutex = new Set((MUTEX_TAGS[p.role] || []).map(normalize));
  const pTags = new Set(p.tags.map(normalize));
  const hasMutexTag = [...pTags].some((t) => mutex.has(t));
  if (hasMutexTag) {
    const currentHasSameMutex = ctx.current.some((c) =>
      c.tags.map(normalize).some((t) => pTags.has(t) && mutex.has(t))
    );
    if (currentHasSameMutex) score -= 100;
  }

  // 5) Meta: Tier + Rate (p.meta.tier / p.meta.rate)
  score += tierBonus(p); // S > A > B ...
  score += rateBonus(p); // preferably if the rate is > 2.5

  score += killerFocusBonus(p, ctx.killerFocus);

  // 6) Lightweight tiebreaker for stability
  score += (100 - Math.min(100, p.name.length)) * 0.01;

  return score;
}

// ---- Mutex tags
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

    // evita il “layout shift” quando sparisce la scrollbar
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

  // Fetch read-only dataset
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

  async function fetchDatasetFromAPI(): Promise<DbdDataset> {
    // 1) Perks
    const [sRes, kRes] = await Promise.all([
      fetch(API_URLS.survivorPerks, { cache: "no-store" }),
      fetch(API_URLS.killerPerks, { cache: "no-store" }),
    ]);
    if (!sRes.ok || !kRes.ok) throw new Error("API not ok");

    const sJson = await sRes.json();
    const kJson = await kRes.json();

    const sArr = Array.isArray(sJson?.data)
      ? sJson.data
      : Array.isArray(sJson)
      ? sJson
      : [];
    const kArr = Array.isArray(kJson?.data)
      ? kJson.data
      : Array.isArray(kJson)
      ? kJson
      : [];

    const survivorPerks = sArr.map(mapSurvivorPerk);
    const killerPerks: Perk[] = kArr.map(mapKillerPerk);
    const perks: Perk[] = [...survivorPerks, ...killerPerks];

    // 2) Slugs killer da owners (per chiamare killerData)
    const killerOwners = Array.from(
      new Set(
        killerPerks
          .map((p) => (p.meta as any)?.owner as string | undefined)
          .filter((o): o is string => Boolean(o))
      )
    );

    const killerSlugs = killerOwners.map(killerSlugFromOwner);

    // 3) KillerData per ognuno (riempie topForKillers)
    const kdMap = await fetchKillerDataForSlugs(killerSlugs); // { slug -> [{name, rank, usage}] }

    // 4) Join su perk name normalizzato
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
          topForKillers: [
            ...prev,
            { slug, rank: row.rank, usage: row.usage } as TopFor,
          ],
        };
      });
    }

    return {
      version: `dennisreep:${new Date().toISOString().slice(0, 10)}`,
      perks,
    };
  }

  // ---- EFFECT SOSTITUITO
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
        // fallback al vecchio JSON statico (o al FALLBACK)
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

  // Tags ONLY for the selected role
  const allTags = useMemo(() => {
    const s = new Set<string>();
    perks
      .filter((p) => p.role === settings.role)
      .forEach((p) => p.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [perks, settings.role]);

  const visiblePerks = useMemo(() => {
    const q = normalize(settings.search);

    // valid owner for the current role
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

    // active tags, but only those that exist for the current role
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

    // actual locked = locked - banned
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

    // pool = same role only, not already chosen, NOT banned
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
      // (the filter above already avoids banned users, this is just defensive)
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

            {/* NEW: anche su desktop */}
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

              <button
                onClick={() => {
                  /* recompute */ setTimeout(runOptimize, 0);
                }}
                className="w-full px-3 py-2 rounded-xl bg-red-900 text-white font-medium hover:bg-red-500"
              >
                Generate build
              </button>

              <div className="mt-4 grid grid-cols-1 gap-3">
                {suggested.map((p: Perk) => (
                  <div
                    key={p.id}
                    className="p-3 rounded-xl bg-zinc-800 border border-red-900/40"
                  >
                    <div className="flex items-center">
                      {/* Icon on the left */}
                      {p.icon && (
                        <img
                          src={p.icon}
                          alt=""
                          className="w-16 h-16 mr-3 mb-2 rounded border border-red-900/40 bg-black/40"
                        />
                      )}

                      {/* Buttons on the right */}
                      <div className="ml-auto flex gap-2 shrink-0">
                        <button
                          className="text-xs px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-700 border border-red-900/40"
                          onClick={() =>
                            setSettings((prev) => ({
                              ...prev,
                              locked: Array.from(
                                new Set([...prev.locked, p.name])
                              ),
                              banned: prev.banned.filter(
                                (i) =>
                                  normalize(i) !== normalize(p.name) &&
                                  normalize(i) !== normalize(p.id)
                              ),
                            }))
                          }
                        >
                          Lock
                        </button>
                        <button
                          className="text-xs px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-700 border border-red-900/40"
                          onClick={() =>
                            setSettings((prev) => ({
                              ...prev,
                              // add to banned (without duplicates)
                              banned: Array.from(
                                new Set([...prev.banned, p.name])
                              ),
                              // remove from any locked items
                              locked: prev.locked.filter(
                                (i) =>
                                  normalize(i) !== normalize(p.name) &&
                                  normalize(i) !== normalize(p.id)
                              ),
                            }))
                          }
                        >
                          Ban
                        </button>
                      </div>
                    </div>

                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-medium">{p.name}</div>

                        {/* Tier / Rate */}
                        <div className="text-xs text-zinc-300">
                          {p.meta?.tier && (
                            <>
                              Tier: {p.meta.tier}
                              {typeof p.meta?.rate !== "undefined" ? " · " : ""}
                            </>
                          )}
                          {(() => {
                            const r = getRate(p);
                            return r != null ? <>Rate: {r.toFixed(1)}</> : null;
                          })()}
                        </div>

                        {/* Role + Owner (killer/survivor) */}
                        <div className="text-xs text-zinc-300 capitalize">
                          {p.role}
                          {p.meta?.owner && (
                            <>
                              {" "}
                              ·{" "}
                              <span className="normal-case">
                                {p.meta.owner}
                              </span>
                            </>
                          )}
                        </div>

                        {/* Tag */}
                        <div className="text-xs text-zinc-300">
                          {p.tags.join(" · ")}
                        </div>
                      </div>
                    </div>

                    {p.synergy && p.synergy.length > 0 && (
                      <div className="text-xs text-zinc-300 mt-1">
                        Sinergie: {p.synergy.join(", ")}
                      </div>
                    )}
                    {p.desc && (
                      <p className="text-xs text-zinc-400 mt-1">{p.desc}</p>
                    )}
                  </div>
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
            <span>Dataset: {dataset?.version ?? "fallback"}</span>
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
  const hasRate =
    typeof perk.meta?.rate !== "undefined" && perk.meta?.rate !== null;

  return (
    <div className="p-3 rounded-2xl bg-zinc-900 border border-red-900/40 hover:border-red-900/40 transition">
      <div className="flex items-start justify-between gap-2">
        <div>
          {/* Icon above the name (if present) */}
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

          {/* Role + Owner (ex. "survivor · Meg Thomas" or "killer · The Artist") */}
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
        <div className="flex gap-2">
          <button
            onClick={onLock}
            className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700"
          >
            Lock
          </button>
          <button
            onClick={onBan}
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

      {/* Desc */}
      {perk.desc && <p className="text-xs text-zinc-400 mt-2">{perk.desc}</p>}
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
