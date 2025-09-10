import { useEffect, useMemo, useState } from "react";

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
 * - Nessuna possibilità di caricare o modificare JSON lato client
 */

// ---- Types
export type Role = "survivor" | "killer";

type Perk = {
  id: string;
  name: string;
  role: Role;
  tags: string[];
  synergy?: string[]; // related perk names or ids
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

function normalize(str: string) {
  return str.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
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

/** Trasforma un rate 0–5 in un bonus centrato su 2.5 (range ~[-7.5, +7.5]) */
function rateBonus(p: Perk) {
  const r = getRate(p);
  if (r == null) return 0;
  const rr = clamp(r, 0, 5);
  return (rr - 2.5) * 3;
}

/** Punteggio da tier (S,A,B,...) */
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

  // 1) Match dei tag selezionati
  for (const t of ctx.tags)
    if (p.tags.map(normalize).includes(normalize(t))) score += 10;

  // 2) Bonus di sinergia con locked + scelti correnti
  const related = new Set((p.synergy || []).map(normalize));
  const lockedNames = ctx.locked.map((n) => normalize(n));
  const currentNames = ctx.current.map((c) => normalize(c.name));
  for (const n of [...lockedNames, ...currentNames])
    if (related.has(n)) score += 8;

  // 3) Penalità anti-sinergia dichiarata
  const anti = new Set((p.anti_synergy || []).map(normalize));
  for (const n of currentNames) if (anti.has(n)) score -= 12;

  // 4) Regole mutex (es. niente doppio exhaustion / scourge_hook)
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
  score += rateBonus(p); // meglio se il rate è > 2.5

  score += killerFocusBonus(p, ctx.killerFocus);

  // 6) Tiebreaker leggero per stabilità
  score += (100 - Math.min(100, p.name.length)) * 0.01;

  return score;
}

// ---- Mutex tags: non vogliamo più di 1 perk con questi tag (per ruolo)
const MUTEX_TAGS: Record<Role, string[]> = {
  survivor: ["exhaustion"],
  killer: ["scourge_hook"],
};

export default function App() {
  const [dataset, setDataset] = useState<DbdDataset | null>(null);
  const [settings, setSettings] = useLocalStorage(SETTINGS_KEY, {
    role: "survivor" as Role,
    selectedTags: ["chase", "stealth", "teamplay"],
    locked: [] as string[],
    banned: [] as string[],
    search: "",
    killerFocus: "" as string,
  });

  // Fetch read-only dataset
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const res = await fetch("/perks.json", { cache: "no-store" });
        if (!res.ok) throw new Error("perks.json non trovato");
        const json = (await res.json()) as DbdDataset;
        if (isMounted) setDataset(json);
      } catch {
        if (isMounted) setDataset(FALLBACK);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const perks = dataset?.perks ?? FALLBACK.perks;

  function prettyKiller(slug: string) {
    return slug
      .split("_")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
  }

  const killerOptions = useMemo(() => {
    const s = new Set<string>();
    perks.forEach((p) => {
      const arr = (p.meta as any)?.topForKillers;
      if (Array.isArray(arr))
        arr.forEach((e: any) => e?.slug && s.add(String(e.slug)));
    });
    return Array.from(s).sort();
  }, [perks]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    perks.forEach((p) => p.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [perks]);

  const visiblePerks = useMemo(() => {
    const q = normalize(settings.search);
    return perks.filter((p) => {
      if (p.role !== settings.role) return false;
      if (q) {
        const hay = `${p.name} ${p.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [perks, settings.search, settings.role]);

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

    // locked effettivi = locked - banned
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

    // pool = solo stesso ruolo, non già scelti, NON bannati
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
      // (il filtro sopra evita già i banned, questo è solo difensivo)
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
    settings.killerFocus, // 👈 aggiungi questa
  ]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 px-4 py-6 flex justify-center">
      <div className="w-full max-w-none mx-auto px-4 py-6 space-y-6">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div>
            <h1 className="!text-xl lg:!text-3xl font-semibold tracking-tight leading-tight">
              DBD Build Optimizer
            </h1>
            <p className="text-zinc-400 text-sm">Version: 0.9.0</p>

            {/* Role sotto la versione su mobile */}
            <div className="mt-2 md:hidden">
              <button
                onClick={() =>
                  setSettings({
                    ...settings,
                    role: settings.role === "survivor" ? "killer" : "survivor",
                  })
                }
                className="w-full lg:w-auto px-3 py-2 rounded-xl bg-red-700/20 hover:bg-red-700/30 border border-red-900/40 text-sm"
              >
                Role:{" "}
                <span className="font-semibold ml-1">
                  {settings.role === "survivor" ? "Survivor" : "Killer"}
                </span>
              </button>
            </div>
          </div>

          {/* Role a destra su desktop */}
          <div className="hidden md:flex gap-2">
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
                className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-red-900/40 outline-none focus:ring-2 focus:ring-red-700/40"
              />
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
              {visiblePerks.map((p) => (
                <PerkCard
                  key={p.id}
                  perk={p}
                  onLock={() =>
                    setSettings((prev) => ({
                      ...prev,
                      locked: Array.from(new Set([...prev.locked, p.name])),
                      // se era bannato, toglilo dai banned
                      banned: prev.banned.filter(
                        (i) =>
                          normalize(i) !== normalize(p.name) &&
                          normalize(i) !== normalize(p.id)
                      ),
                    }))
                  }
                  onBan={() =>
                    setSettings((prev) => ({
                      ...settings,
                      banned: Array.from(new Set([...settings.banned, p.name])),
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
            <div className="p-4 rounded-2xl bg-zinc-900 border border-red-900/40 xl:sticky :top-4">
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
                className="w-full px-3 py-2 rounded-xl bg-red-600 text-white font-medium hover:bg-red-500"
              >
                Generate build
              </button>

              <div className="mt-4 grid grid-cols-1 gap-3">
                {suggested.map((p) => (
                  <div
                    key={p.id}
                    className="p-3 rounded-xl bg-zinc-800 border border-red-900/40"
                  >
                    <div className="flex items-center">
                      {/* Icona a sinistra */}
                      {p.icon && (
                        <img
                          src={p.icon}
                          alt=""
                          className="w-16 h-16 mr-3 mb-2 rounded border border-red-900/40 bg-black/40"
                        />
                      )}

                      {/* Bottoni a destra */}
                      <div className="ml-auto flex gap-2 shrink-0">
                        <button
                          className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-red-900/40"
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
                          className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-red-900/40"
                          onClick={() =>
                            setSettings((prev) => ({
                              ...prev,
                              // aggiungi ai banned (senza duplicati)
                              banned: Array.from(
                                new Set([...prev.banned, p.name])
                              ),
                              // rimuovi dagli eventuali locked
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
                          {typeof p.meta?.rate !== "undefined" && (
                            <>Rate: {Number(p.meta.rate).toFixed(1)}</>
                          )}
                        </div>

                        {/* Ruolo + Owner (killer/survivor) */}
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

                        {/* Tag (come prima) */}
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
          <p>Dataset: {dataset?.version ?? "fallback"}</p>
        </footer>
      </div>
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
          {/* Icona sopra al nome (se presente) */}
          {perk.icon && (
            <img
              src={perk.icon}
              alt={perk.name}
              className="w-16 h-16 mb-2 rounded-lg border border-red-900/40 object-contain bg-black/40"
              loading="lazy"
              decoding="async"
            />
          )}

          {/* Nome */}
          <div className="font-medium">{perk.name}</div>

          {/* Tier / Rate */}
          <div className="text-xs text-zinc-300">
            {perk.meta?.tier && (
              <>
                Tier: {perk.meta.tier}
                {hasRate ? " · " : ""}
              </>
            )}
            {hasRate && <>Rate: {Number(perk.meta!.rate).toFixed(1)}</>}
          </div>

          {/* Ruolo + Owner (per es. "survivor · Meg Thomas" o "killer · The Artist") */}
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

        {/* Azioni */}
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

      {/* Descrizione */}
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
