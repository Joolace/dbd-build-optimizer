// scripts/make_perks_from_dennisreep.mjs
// Genera public/perks.json estraendo i perk da dennisreep.nl (killer + survivor).

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCES = [
  { role: "killer", url: "https://dennisreep.nl/dbd/perks/killer/" },
  { role: "survivor", url: "https://dennisreep.nl/dbd/perks/survivor/" },
];

const KILLERS = [
  "nurse",
  "blight",
  "dark_lord",
  "executioner",
  "singularity",
  "lich",
  "animatronic",
  "artist",
  "ghoul",
  "oni",
  "knight",
  "unknown",
  "spirit",
  "xenomorph",
  "nightmare",
  "hillbilly",
  "plague",
  "mastermind",
  "nemesis",
  "clown",
  "shape",
  "cenobite",
  "huntress",
  "good_guy",
  "demogorgon",
  "cannibal",
  "legion",
  "deathslinger",
  "onryo",
  "dredge",
  "pig",
  "wraith",
  "trickster",
  "doctor",
  "twins",
  "ghost_face",
  "houndmaster",
  "hag",
  "trapper",
  "skull_merchant",
];

/** Normalise text (multiple spaces, NBSP) */
function clean(t) {
  return (t ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** stable ID based on name */
function toId(name) {
  return clean(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** extracts the first number (integer/decimal) from a string */
function parseFirstNumber(s) {
  const m = clean(s).match(/[0-9]+(?:[.,][0-9]+)?/);
  return m ? parseFloat(m[0].replace(",", ".")) : null;
}

async function scrapeKillerTopPerks(slug) {
  const url = `https://dennisreep.nl/dbd/killers/${slug}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "perk-scraper/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Find headings that contain both ‘Top’ and “Perks” (e.g. ‘Top Artist Perks’)
  let start = null;
  $("h1,h2,h3,h4").each((_, el) => {
    const t = clean($(el).text()).toLowerCase();
    if (!start && t.includes("top") && t.includes("perks")) start = el;
  });
  if (!start) return { slug, perks: [] };

  // Section between this heading and the next one
  const $section = $(start).nextUntil("h1,h2,h3,h4");
  const names = [];

  // 1) Try reading the Top Perks table: Icon | Name | Description | Killer | Tier | Rate
  $section.find("table tbody tr").each((_, tr) => {
    const $td = $(tr).find("td");
    if ($td.length >= 2) {
      let nm = clean($td.eq(1).text()) || clean($td.eq(1).find("a").text());
      if (nm && nm.length <= 80) names.push(nm);
    }
  });

  // 2) generic fallback if we did not find the table (take names from link/list/item)
  if (names.length === 0) {
    $section
      .find("a, li, td, .perk, .perk-name, .card, .grid *")
      .each((_, node) => {
        const txt = clean($(node).text());
        if (
          txt &&
          txt.length <= 60 &&
          /[A-Za-z]/.test(txt) &&
          !/top perks/i.test(txt)
        ) {
          names.push(txt);
        }
      });
  }

  // Dedupe while maintaining order and limits
  const out = [];
  const seen = new Set();
  for (const n of names) {
    const k = n.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(n);
    }
  }
  return { slug, perks: out.slice(0, 12) };
}

/**
 * Let's break down the table: Icon | Name | Description | Owner | Tier | Rate
 * If the layout changes, try adjusting the selectors here.
 */
async function scrapePerks(role, url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "perk-scraper/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const perks = [];

  // Table rows (skip header)
  $("table tbody tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if ($tds.length < 3) return;

    // Minimum columns
    const name = clean($tds.eq(1).text()); // Name
    const descCell = $tds.eq(2).clone();
    descCell.find(".dynamicTitle").remove();

    // Remove unnecessary/duplicate wrappers (PC/mobile view, tooltip, etc.)
    descCell
      .find(
        ".pcView, .mobileView, .tooltip, .tooltipBaseText, .tooltiptext, .tooltipTextWrapper, .linkIncluded, .iconless, .borderless"
      )
      .remove();

    // Keep ONLY the internal text of coloured or styled <span> tags
    descCell.find("span.luaClr, span.clr, span[style]").each((_, el) => {
      const txt = $(el).text();
      $(el).replaceWith(txt); // un-wrap per tenere i numeri (es. 2/4/6)
    });

    let desc = clean(descCell.text());

    // (Final check) if for some reason any HTML tags remain visible, remove them
    if (/<\/?[a-z][\s\S]*>/i.test(desc)) {
      desc = clean(desc.replace(/<\/?[^>]+>/g, ""));
    }

    // Hardening: remove any remaining disclaimer phrases from the text.
    desc = desc
      .replace(
        /This description is based on[^.]*upcoming Patch[^.]*\.\s*/gi,
        ""
      )
      .replace(/^Patch\s*\d+(?:\.\d+)*[^.]*\.\s*/gi, ""); // Description
    if (!name) return;

    // Owner/Tier/Rate if applicable
    const owner = $tds.length >= 4 ? clean($tds.eq(3).text()) : null; // Killer/Survivor name
    const tierRaw = $tds.length >= 5 ? clean($tds.eq(4).text()) : null; // e.g. "S", "A"
    const rateRaw = $tds.length >= 6 ? clean($tds.eq(5).text()) : null; // e.g. "4.6"
    const tier = tierRaw
      ? tierRaw.replace(/[^A-Za-z]/g, "").toUpperCase() || null
      : null;
    const rate = rateRaw ? parseFirstNumber(rateRaw) : null;

    // Basic tags from the text (you can extend freely)
    const tags = [];
    const lower = (name + " " + desc).toLowerCase();
    if (lower.includes("exhaust")) tags.push("exhaustion");
    if (lower.includes("haste")) tags.push("speed");
    if (lower.includes("aura")) tags.push("aura-reading");
    if (lower.includes("gen")) tags.push("generator");
    if (lower.includes("hook")) tags.push("hook");
    if (lower.includes("endurance")) tags.push("endurance");
    if (lower.includes("stealth") || lower.includes("scratch"))
      tags.push("stealth");
    // small help: tag for Scourge Hook
    if (/^scourge hook/i.test(name)) tags.push("scourge_hook");

    // Icon (if present)
    const iconEl = $tds.eq(0).find("img").first();
    const icon = iconEl.attr("src")
      ? new URL(iconEl.attr("src"), url).href
      : null;

    // Build the perk while maintaining the existing ‘structure’
    const perk = {
      id: toId(name),
      name,
      role,
      tags,
      desc,
      icon,
    };

    // Non-invasive additions in meta
    const meta = {};
    if (owner) meta.owner = owner;
    if (tier) meta.tier = tier; // "S", "A", "B", ...
    if (rate !== null) meta.rate = rate; // number (float)
    if (Object.keys(meta).length > 0) perk.meta = meta;

    perks.push(perk);
  });

  // Dedupe by name (case-insensitive)
  const seen = new Set();
  const out = [];
  for (const p of perks) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function main() {
  const results = [];
  for (const src of SOURCES) {
    const items = await scrapePerks(src.role, src.url);
    results.push(...items);
  }

  // Map by normalised name -> perk
  // Map by name and by ID
  const byName = new Map();
  const byId = new Map();
  for (const p of results) {
    byName.set(p.name.toLowerCase(), p);
    byId.set(p.id, p);
  }

  // For each killer, mark the top perks with { slug, rank }
  for (const slug of KILLERS) {
    try {
      const { perks: topNames } = await scrapeKillerTopPerks(slug);
      topNames.forEach((nm, idx) => {
        // 1) match test by name
        let perk = byName.get(nm.toLowerCase());
        // 2) fallback: try for normalised ID
        if (!perk) perk = byId.get(toId(nm));
        if (!perk) return;

        perk.meta = perk.meta || {};
        perk.meta.topForKillers = perk.meta.topForKillers || [];
        if (!perk.meta.topForKillers.some((x) => x.slug === slug)) {
          perk.meta.topForKillers.push({ slug, rank: idx + 1 });
        }
      });
      console.log(`[top] ${slug}: ${topNames.length} nomi trovati`);
    } catch (e) {
      console.warn(`Top Perks falliti per ${slug}:`, e.message);
    }
  }

  const data = {
    version: new Date().toISOString().slice(0, 10),
    perks: results,
  };

  // Write to public/perks.json
  const outDir = path.join(__dirname, "..", "public");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "perks.json");
  await fs.writeFile(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`OK: scritto ${outPath} con ${data.perks.length} perk totali.`);
}

main().catch((err) => {
  console.error("Errore:", err);
  process.exit(1);
});
