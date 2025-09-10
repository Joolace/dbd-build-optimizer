// scripts/make_perks_from_dennisreep.mjs
// Genera public/perks.json estraendo i perk da dennisreep.nl (killer + survivor).

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCES = [
  { role: "killer",   url: "https://dennisreep.nl/dbd/perks/killer/"   },
  { role: "survivor", url: "https://dennisreep.nl/dbd/perks/survivor/" },
];

/** Normalizza testo (spazi multipli, NBSP) */
function clean(t) {
  return (t ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** id stabile a partire dal nome */
function toId(name) {
  return clean(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** estrae primo numero (intero/decimale) da una stringa */
function parseFirstNumber(s) {
  const m = clean(s).match(/[0-9]+(?:[.,][0-9]+)?/);
  return m ? parseFloat(m[0].replace(",", ".")) : null;
}

/**
 * Parsiamo la tabella: Icon | Name | Description | Owner | Tier | Rate
 * Se il layout cambia, prova ad adattare i selettori qui.
 */
async function scrapePerks(role, url) {
  const res = await fetch(url, { headers: { "User-Agent": "perk-scraper/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const perks = [];

  // Righe tabella (salta header)
  $("table tbody tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if ($tds.length < 3) return;

    // Colonne minime
    const name = clean($tds.eq(1).text());       // Name
    const desc = clean($tds.eq(2).text());       // Description
    if (!name) return;

    // Owner/Tier/Rate se presenti
    const owner = $tds.length >= 4 ? clean($tds.eq(3).text()) : null; // Killer/Survivor name
    const tierRaw = $tds.length >= 5 ? clean($tds.eq(4).text()) : null; // e.g. "S", "A"
    const rateRaw = $tds.length >= 6 ? clean($tds.eq(5).text()) : null; // e.g. "4.6"
    const tier = tierRaw ? tierRaw.replace(/[^A-Za-z]/g, "").toUpperCase() || null : null;
    const rate = rateRaw ? parseFirstNumber(rateRaw) : null;

    // Tag basilari dal testo (puoi estendere liberamente)
    const tags = [];
    const lower = (name + " " + desc).toLowerCase();
    if (lower.includes("exhaust")) tags.push("exhaustion");
    if (lower.includes("haste")) tags.push("speed");
    if (lower.includes("aura")) tags.push("aura-reading");
    if (lower.includes("gen")) tags.push("generator");
    if (lower.includes("hook")) tags.push("hook");
    if (lower.includes("endurance")) tags.push("endurance");
    if (lower.includes("stealth") || lower.includes("scratch")) tags.push("stealth");
    // piccolo aiuto: tag per Scourge Hook
    if (/^scourge hook/i.test(name)) tags.push("scourge_hook");

    // Icona (se presente)
    const iconEl = $tds.eq(0).find("img").first();
    const icon = iconEl.attr("src") ? new URL(iconEl.attr("src"), url).href : null;

    // Costruisci il perk mantenendo la "struttura" esistente
    const perk = {
      id: toId(name),
      name,
      role,
      tags,
      desc,
      icon,
    };

    // Aggiunte NON invasive in meta
    const meta = {};
    if (owner) meta.owner = owner;
    if (tier) meta.tier = tier;   // "S", "A", "B", ...
    if (rate !== null) meta.rate = rate; // numero (float)
    if (Object.keys(meta).length > 0) perk.meta = meta;

    perks.push(perk);
  });

  // Dedupe per nome (case-insensitive)
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

  const data = {
    version: new Date().toISOString().slice(0, 10),
    perks: results,
  };

  // Scrivi in public/perks.json
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
