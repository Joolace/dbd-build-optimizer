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

/**
 * Normalizza un testo (spazi, whitespace multiplo)
 */
function clean(t) {
  return (t ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Crea un id stabile a partire dal nome perk
 */
function toId(name) {
  return clean(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Parsiamo la tabella: colonne attese (Icon, Name, Description, [Killer/Survivor], Tier, Rate)
 * Le pagine sorgenti:
 *  - Killer:   https://dennisreep.nl/dbd/perks/killer/
 *  - Survivor: https://dennisreep.nl/dbd/perks/survivor/
 */
async function scrapePerks(role, url) {
  const res = await fetch(url, { headers: { "User-Agent": "perk-scraper/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const perks = [];

  // Troviamo righe della tabella principale (saltiamo l’header)
  $("table tbody tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if ($tds.length < 3) return;

    // Struttura tipica sulle pagine di Dennis Reep: Icon | Name | Description | (Owner) | Tier | Rate
    const name = clean($tds.eq(1).text());        // colonna 2: Name
    const desc = clean($tds.eq(2).text());        // colonna 3: Description

    if (!name) return;

    // Proviamo a ricavare tag basilari dal testo (opzionale, migliorabile)
    const tags = [];
    const lower = (name + " " + desc).toLowerCase();
    if (lower.includes("exhaust")) tags.push("exhaustion");
    if (lower.includes("haste")) tags.push("speed");
    if (lower.includes("aura")) tags.push("aura-reading");
    if (lower.includes("gen")) tags.push("generator");
    if (lower.includes("hook")) tags.push("hook");
    if (lower.includes("endurance")) tags.push("endurance");
    if (lower.includes("stealth") || lower.includes("scratch")) tags.push("stealth");

    // Icona (se presente)
    const iconEl = $tds.eq(0).find("img").first();
    const icon = iconEl.attr("src") ? new URL(iconEl.attr("src"), url).href : null;

    perks.push({
      id: toId(name),
      name,
      role,
      tags,
      desc,
      icon
    });
  });

  // Dedupe per nome
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

  // Scrive in public/perks.json
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
