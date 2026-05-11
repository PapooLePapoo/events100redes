/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   MULTI-SITE EVENT SCRAPER                                  ║
 * ║   Sites : Eventbrite · 3cket · ViralAgenda · TurismoC.     ║
 * ║           FestasArraiais · Feverup · Ticketline             ║
 * ║           AondeVamos · Agenda Coimbra                       ║
 * ║   Output : 1 fichier JSON par événement + push GitHub       ║
 * ║   Licence : MIT — GAFAM free                                ║
 * ║   Runtime : Node.js >= 18                                   ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * FORMAT JSON normalisé (identique à l'exemple fourni) :
 * {
 *   id, titre, categories, source, date_debut, date_fin,
 *   ongoing, lieu, image, prix: { valeur, gratuit },
 *   tickets_url, lien_detail, source_url, scrape_at
 * }
 */

import * as cheerio from "cheerio";
import { mkdir, writeFile } from "fs/promises";
import { join }             from "path";
import crypto               from "crypto";

// ============================================================
//  CONFIGURATION — À MODIFIER SELON VOS BESOINS
// ============================================================
const CONFIG = {

  // Dossier de sortie local — upload le contenu de ce dossier via FTP
  // dans scraped_events/ sur le serveur
  OUTPUT_DIR: "./output",

  MAX_EVENTS:       0,            // 0 = tous, sinon limite par site
  SKIP_PAST_EVENTS: true,
  DEBUG:            true,

  // Activer / désactiver des scrapers individuellement
  SCRAPERS: {
    coimbra:       true,
    eventbrite:    true,
    trecket:       true,
    viralagenda:   true,
    turismo_centro:true,
    festasarraiais:true,
    feverup:       true,
    ticketline:    true,
    aondevamos:    true,
  },
};

// ============================================================
//  UTILITAIRES COMMUNS
// ============================================================

function log(msg)  { if (CONFIG.DEBUG) console.log(`[DEBUG] ${msg}`); }
function warn(msg) { console.warn(`[WARN]  ${msg}`); }

function cleanText(str) {
  if (!str || typeof str !== "string") return null;
  return str.trim().replace(/\s+/g, " ") || null;
}

/** Génère un ID stable à partir d'une URL ou d'une chaîne */
function stableId(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 12);
}

/**
 * Normalise N'IMPORTE QUELLE représentation de date vers
 * le format ISO local uniforme : "YYYY-MM-DDTHH:MM:SS"
 *
 * Formats gérés :
 *   "2026-04-14T09:30:00+01:00"  → "2026-04-14T09:30:00"
 *   "2026-04-14T09:30:00Z"       → "2026-04-14T09:30:00"
 *   "2026-04-14"                 → "2026-04-14T00:00:00"
 *   "14/04/2026"                 → "2026-04-14T00:00:00"
 *   "14/04/2026 09:30"           → "2026-04-14T09:30:00"
 *   "14.04.2026"                 → "2026-04-14T00:00:00"
 *   "07.05.2026"                 → "2026-05-07T00:00:00"
 *   "Thursday, 7 May"            → "2026-05-07T00:00:00"
 *   "7 May 2026"                 → "2026-05-07T00:00:00"
 *   "today" / "hoje"             → date du jour T00:00:00
 *   "Ongoing"                    → null
 */
function parseDate(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) return isNaN(raw) ? null : _dateToISO(raw);

  const s = String(raw).trim();
  if (!s || /^ongoing$/i.test(s)) return null;

  // 1. ISO complet avec timezone — conserver l'heure locale, supprimer offset/Z
  const isoFull = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoFull) {
    const time = isoFull[2].length === 5 ? isoFull[2] + ":00" : isoFull[2];
    return `${isoFull[1]}T${time}`;
  }

  // 2. ISO date seule "2026-04-14"
  const isoDate = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00`;

  // 3. dd/mm/yyyy [hh:mm[:ss]]
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s](\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const [, d, m, y, hm, ss] = dmy;
    return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T${hm ?? "00:00"}:${ss ?? "00"}`;
  }

  // 4. dd.mm.yyyy [hh:mm[:ss]]  — format TurismoCentro "07.05.2026"
  const dotDmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[T\s](\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (dotDmy) {
    const [, d, m, y, hm, ss] = dotDmy;
    return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T${hm ?? "00:00"}:${ss ?? "00"}`;
  }

  // 5. yyyy/mm/dd
  const ymd = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00`;

  // 6. Texte naturel avec mois en lettres (EN/PT)
  //    "7 May 2026" | "Thursday, 7 May" | "tomorrow, 6 May" | "April 14, 2026"
  const MONTHS = {
    jan:1,january:1,janeiro:1,
    fev:2,feb:2,february:2,fevereiro:2,
    mar:3,march:3,marco:3,
    apr:4,abr:4,april:4,abril:4,
    may:5,mai:5,maio:5,
    jun:6,june:6,junho:6,
    jul:7,july:7,julho:7,
    aug:8,ago:8,august:8,agosto:8,
    sep:9,set:9,september:9,setembro:9,
    oct:10,out:10,october:10,outubro:10,
    nov:11,november:11,novembro:11,
    dec:12,dez:12,december:12,dezembro:12,
  };
  // Supprimer le préfixe de jour ("Thursday,", "tomorrow,", etc.)
  const stripped = s.replace(/^(?:today|hoje|tomorrow|amanhã|monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)[,\s]*/i, "").trim();
  // "7 May [2026]"
  const natA = stripped.match(/^(\d{1,2})\s+([a-záàãéêíóôõúç]+)(?:\s+(\d{4}))?/i);
  // "May 7[, 2026]"
  const natB = stripped.match(/^([a-záàãéêíóôõúç]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  const nat = natA || natB;
  if (nat) {
    let day, monStr, year;
    if (natA) { [, day, monStr, year] = natA; }
    else       { [, monStr, day, year] = natB; }
    const monNum = MONTHS[monStr.toLowerCase().slice(0, 3)];
    if (monNum) {
      const now = new Date();
      let y = year ? parseInt(year) : now.getFullYear();
      if (!year) {
        const candidate = new Date(y, monNum - 1, parseInt(day));
        // Si la date est passée de plus de 2 mois, passer à l'année suivante
        const threshold = new Date(); threshold.setMonth(threshold.getMonth() - 2);
        if (candidate < threshold) y++;
      }
      return `${y}-${String(monNum).padStart(2,"0")}-${String(day).padStart(2,"0")}T00:00:00`;
    }
  }

  // 7. "today" / "hoje"
  if (/^(?:today|hoje)$/i.test(s)) return _dateToISO(new Date());

  // 8. Dernier recours : Date natif JS
  const d = new Date(s);
  if (!isNaN(d)) return _dateToISO(d);

  return null;
}

/** Formate un objet Date JS en "YYYY-MM-DDTHH:MM:SS" (heure locale) */
function _dateToISO(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isPast(isoStr) {
  if (!isoStr) return false;
  return new Date(isoStr) < new Date();
}

async function fetchHTML(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,fr;q=0.8,en;q=0.7",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

async function fetchJSON(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; EventScraper/2.0)",
      "Accept":     "application/json",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

/** Extraction JSON-LD depuis un HTML */
function extractJsonLD($) {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (Array.isArray(data)) results.push(...data);
      else results.push(data);
    } catch { /* ignore */ }
  });
  return results;
}

/** Template normalisé — garantit tous les champs */
function normalize(partial) {
  return {
    id:          partial.id          ?? stableId(partial.lien_detail ?? Math.random().toString()),
    titre:       cleanText(partial.titre) ?? "(sans titre)",
    categories:  Array.isArray(partial.categories) ? partial.categories : [],
    source:      partial.source      ?? null,
    date_debut:  partial.date_debut  ?? null,
    date_fin:    partial.date_fin    ?? null,
    ongoing:     partial.ongoing     ?? false,
    lieu:        cleanText(partial.lieu) ?? null,
    image:       partial.image       ?? null,
    prix: {
      valeur:  partial.prix?.valeur  ?? null,
      gratuit: partial.prix?.gratuit ?? false,
    },
    tickets_url: partial.tickets_url ?? null,
    lien_detail: partial.lien_detail ?? null,
    source_url:  partial.source_url  ?? null,
    scrape_at:   new Date().toISOString(),
  };
}

// ============================================================
//  SCRAPER 1 — AGENDA COIMBRA  (Nuxt 3 __NUXT_DATA__)
// ============================================================

function reviveNuxtData(flat) {
  const cache = new Map();
  function walk(index) {
    if (typeof index !== "number" || index < 0 || index >= flat.length) return undefined;
    if (cache.has(index)) return cache.get(index);
    const node = flat[index];
    if (node === null || typeof node !== "object") { cache.set(index, node); return node; }
    if (Array.isArray(node)) {
      if (node.length >= 1 && typeof node[0] === "string") {
        const tag = node[0], payload = node[1];
        if (["Reactive","ShallowReactive","Ref","ShallowRef"].includes(tag)) { const v = walk(payload); cache.set(index,v); return v; }
        if (tag === "Date")      { const d = new Date(payload); cache.set(index,d); return d; }
        if (tag === "undefined") { cache.set(index,undefined); return undefined; }
        if (tag === "NaN")       { cache.set(index,NaN);       return NaN; }
        if (tag === "Infinity")  { cache.set(index,Infinity);  return Infinity; }
        if (tag === "-Infinity") { cache.set(index,-Infinity); return -Infinity; }
        if (tag === "-0")        { cache.set(index,-0);        return -0; }
      }
      const arr = []; cache.set(index,arr);
      for (const item of node) arr.push(typeof item === "number" ? walk(item) : item);
      return arr;
    }
    const obj = {}; cache.set(index,obj);
    for (const [k,v] of Object.entries(node)) obj[k] = typeof v === "number" ? walk(v) : v;
    return obj;
  }
  return walk(0);
}

function resolveUrlTemplate(tpl, { key, filename, token, size="medium" } = {}) {
  if (!tpl) return null;
  return tpl.replace("{KEY}",key??"").replace("{FILENAME}",filename??"").replace("{TOKEN}",token??"").replace("{SIZE}",size);
}

function extractImageCoimbra(files) {
  if (!files || typeof files !== "object") return null;
  for (const file of Object.values(files)) {
    if (!file || file.type !== "image") continue;
    const { key, filename, token, url, url_format, webp_filename, thumb_filename, thumb_url } = file;
    if (!token && url && key && filename) return resolveUrlTemplate(url, { key, filename });
    if (token && url_format && key && filename) return resolveUrlTemplate(url_format, { key, filename, token });
    if (thumb_url && key) { const fn = webp_filename ?? thumb_filename ?? filename; if (fn) return resolveUrlTemplate(thumb_url, { key, filename: fn, size:"medium" }); }
  }
  return null;
}

async function scrapeCoimbra() {
  const SOURCE_URL = "https://agenda.coimbra.pt/";
  log("→ Coimbra Agenda");
  const html = await fetchHTML(SOURCE_URL);
  const $ = cheerio.load(html);
  const nuxtRaw = $("#__NUXT_DATA__").text().trim();
  if (!nuxtRaw) { warn("Coimbra: __NUXT_DATA__ introuvable"); return []; }

  let flat; try { flat = JSON.parse(nuxtRaw); } catch { warn("Coimbra: parse error"); return []; }
  const state = reviveNuxtData(flat);

  let eventsRaw = {};
  for (const pageData of Object.values(state?.data ?? {})) {
    if (pageData && typeof pageData === "object" && pageData.events && typeof pageData.events === "object" && !Array.isArray(pageData.events)) {
      eventsRaw = pageData.events; break;
    }
  }
  if (!Object.keys(eventsRaw).length) { warn("Coimbra: aucun bloc events"); return []; }

  const seen = new Set(), allEvs = [];
  for (const bucket of Object.values(eventsRaw)) {
    const list = Array.isArray(bucket) ? bucket : Object.values(bucket ?? {});
    for (const ev of list) {
      const id = ev?.key ?? ev?.id ?? null;
      if (!id || seen.has(id)) continue;
      seen.add(id); allEvs.push(ev);
    }
  }

  const now = new Date(), events = [];
  for (const ev of allEvs) {
    if (!ev?.key) continue;
    const sessions = Array.isArray(ev.sessions) ? ev.sessions : Object.values(ev.sessions ?? {});
    const getdt = (s) => { const d = s?.datetime ?? s; return typeof d === "string" ? d : null; };
    const upcoming = sessions.filter(s => { const dt = getdt(s?.start); return !dt || new Date(dt) >= now || s.is_ongoing; });
    if (CONFIG.SKIP_PAST_EVENTS && !upcoming.length && sessions.length) continue;
    const next = upcoming[0] ?? sessions[0] ?? {};
    const meta = ev.metadata ?? {};
    let prix = null;
    if (meta.price != null) { const val = parseFloat(String(meta.price).replace(",",".")); prix = { valeur: isNaN(val)?null:val, gratuit: val===0 }; }

    events.push(normalize({
      id:          ev.key,
      titre:       ev.title,
      categories:  Array.isArray(ev.categories) ? ev.categories : [],
      source:      ev.source ?? "CM Coimbra",
      date_debut:  getdt(next.start),
      date_fin:    getdt(next.end),
      ongoing:     next.is_ongoing ?? false,
      lieu:        next.location ?? meta.location,
      image:       extractImageCoimbra(ev.files),
      prix,
      tickets_url: meta.tickets_url ?? null,
      lien_detail: `https://agenda.coimbra.pt/event/${ev.key}`,
      source_url:  SOURCE_URL,
    }));
  }
  log(`  Coimbra: ${events.length} événement(s)`);
  return events;
}


// ============================================================
//  SCRAPER 2 — EVENTBRITE
//  Stratégie : window.__SERVER_DATA__ + JSON-LD + regex
//  Eventbrite rend ses pages en JS côté client — le HTML brut
//  embarque néanmoins les données de listing dans une variable
//  globale window.__SERVER_DATA__ sérialisée en JSON.
//  On interroge plusieurs villes portugaises pour maximiser la
//  couverture, puis on dédoublonne par event_id.
// ============================================================

async function scrapeEventbrite() {
  const SOURCE_URL = "https://www.eventbrite.pt/";
  log("-> Eventbrite PT");
  const events = [];
  const seenIds = new Set();

  // Villes portugaises couvertes
  const CITIES = [
    { slug: "portugal--lisboa",  label: "Lisboa"  },
    { slug: "portugal--porto",   label: "Porto"   },
    { slug: "portugal--coimbra", label: "Coimbra" },
    { slug: "portugal--braga",   label: "Braga"   },
    { slug: "portugal--portugal",label: "Portugal"},
  ];

  for (const city of CITIES) {
    const listUrl = "https://www.eventbrite.pt/d/" + city.slug + "/all-events/?page=1";

    try {
      const html = await fetchHTML(listUrl, {
        "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "pt-PT,pt;q=0.9",
        "Cache-Control":   "no-cache",
        "Referer":         "https://www.eventbrite.pt/",
      });

      let items = [];

      // Methode 1 : window.__SERVER_DATA__
      const sdMatch = html.match(/window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/);
      if (sdMatch) {
        try {
          const sd = JSON.parse(sdMatch[1]);
          items = sd?.search_data?.events?.results ?? [];
          log("  Eventbrite " + city.label + ": __SERVER_DATA__ -> " + items.length + " items");
        } catch { /* ignore */ }
      }

      // Methode 2 : JSON-LD
      if (!items.length) {
        const $ = cheerio.load(html);
        const ld = extractJsonLD($).filter(function(d) { return d["@type"] === "Event"; });
        if (ld.length) {
          log("  Eventbrite " + city.label + ": JSON-LD -> " + ld.length + " items");
          for (const ev of ld) {
            const id = stableId(ev.url ?? ev.name ?? String(Math.random()));
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const debut = parseDate(ev.startDate);
            if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
            const price = ev.offers && ev.offers.price != null ? parseFloat(ev.offers.price) : null;
            events.push(normalize({
              id, titre: ev.name, categories: ev.genre ? [ev.genre] : [],
              source: "Eventbrite", date_debut: debut, date_fin: parseDate(ev.endDate),
              lieu: ev.location && (ev.location.name ?? ev.location.address?.addressLocality),
              image: Array.isArray(ev.image) ? ev.image[0] : ev.image,
              prix: price != null ? { valeur: price, gratuit: price === 0 } : null,
              tickets_url: ev.offers?.url ?? ev.url, lien_detail: ev.url, source_url: SOURCE_URL,
            }));
          }
          continue;
        }
      }

      // Methode 3 : regex sur "events":{"results":[...]}
      if (!items.length) {
        const m = html.match(/"results"\s*:\s*(\[[\s\S]{50,100000}?\])\s*,\s*"pagination"/);
        if (m) {
          try {
            items = JSON.parse(m[1]);
            log("  Eventbrite " + city.label + ": regex results -> " + items.length + " items");
          } catch { /* ignore */ }
        }
      }

      // Normalisation des items
      for (const ev of items) {
        const id = String(ev.id ?? stableId(ev.url ?? ev.name ?? String(Math.random())));
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const debut = parseDate(ev.start_date ?? (ev.start && (ev.start.local ?? ev.start.utc)) ?? ev.startDate);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;

        const venueName = (ev.venue && (ev.venue.name ?? (ev.venue.address && ev.venue.address.localized_address_display)))
          ?? (ev.primary_venue && ev.primary_venue.name) ?? null;

        const imgUrl = (ev.image && ev.image.url)
          ?? (ev.logo && (ev.logo.url ?? (ev.logo.original && ev.logo.original.url)))
          ?? (typeof ev.image === "string" ? ev.image : null);

        const isFree = ev.is_free ?? (ev.ticket_availability && ev.ticket_availability.is_free) ?? false;
        const minPrice = (ev.ticket_availability && ev.ticket_availability.minimum_ticket_price && ev.ticket_availability.minimum_ticket_price.major_value)
          ?? (ev.min_ticket_price && ev.min_ticket_price.major_value) ?? null;

        events.push(normalize({
          id,
          titre:       (ev.name && ev.name.text) ?? ev.name ?? ev.title,
          categories:  ev.tags ? ev.tags.map(function(t) { return t.display_name ?? t.tag; }) : [],
          source:      "Eventbrite",
          date_debut:  debut,
          date_fin:    parseDate(ev.end_date ?? (ev.end && (ev.end.local ?? ev.end.utc)) ?? ev.endDate),
          lieu:        venueName,
          image:       imgUrl,
          prix:        { valeur: isFree ? 0 : (minPrice ? parseFloat(minPrice) : null), gratuit: isFree },
          tickets_url: ev.url,
          lien_detail: ev.url,
          source_url:  SOURCE_URL,
        }));
      }

    } catch (e) { warn("Eventbrite (" + city.label + "): " + e.message); }
  }

  log("  Eventbrite total: " + events.length + " evenement(s)");
  return events;
}



// ============================================================
//  SCRAPER 3 — 3CKET
//  Structure réelle : SPA mais HTML rendu côté serveur.
//  La page /en/discover/ liste les events avec leurs liens.
//  Chaque lien /en/event/SLUG contient titre, date, lieu.
//  Stratégie : parser la liste → extraire les slugs →
//  visiter chaque page de détail pour date/lieu précis.
// ============================================================

async function scrape3cket() {
  const SOURCE_URL = "https://3cket.com/en/discover/";
  log("-> 3cket");
  const events = [];

  try {
    const html = await fetchHTML(SOURCE_URL);
    const $ = cheerio.load(html);

    // Extraire tous les liens d'events (/en/event/SLUG)
    const eventLinks = [];
    const seen = new Set();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/^\/(?:en|pt)\/event\/([^?#]+)/);
      if (!m || seen.has(m[1])) return;
      // Filtrer les liens parasites (cookies, help, etc.)
      if (href.includes("cookie") || href.includes("help")) return;
      seen.add(m[1]);

      // Titre : texte du lien ou du heading dans le parent
      const $parent = $(el).closest("a, article, div");
      // 3cket duplique le texte (titre deux fois dans le lien)
      const rawText = cleanText($(el).text());
      // Supprimer la répétition : "Titre TitreDate" -> prendre la première moitié
      const dedup = rawText ? rawText.replace(/^(.{5,80})\1.*$/s, "$1").trim() : null;

      // Date & lieu parsés depuis le texte du lien
      const fullText = rawText || "";
      // Patterns: "tomorrow, 6 May", "Thursday, 7 May", "7 May - 10 May", "Ongoing"
      const dateMatch = fullText.match(/(\d{1,2}\s+\w+(?:\s+\d{4})?|\w+day,\s+\d{1,2}\s+\w+|Ongoing|today)/i);
      const dateRaw = dateMatch ? dateMatch[1] : null;

      eventLinks.push({
        slug: m[1],
        url:  "https://3cket.com/en/event/" + m[1],
        titre: dedup,
        dateRaw,
      });
    });

    log("  3cket: " + eventLinks.length + " liens trouves");

    // Visiter chaque page de detail pour récupérer date ISO et lieu
    // On limite a 40 pour ne pas surcharger
    const limit = Math.min(eventLinks.length, 40);
    for (let i = 0; i < limit; i++) {
      const link = eventLinks[i];
      try {
        const dhtml = await fetchHTML(link.url);
        const $d = cheerio.load(dhtml);

        // JSON-LD sur la page de detail
        const ld = extractJsonLD($d).find(function(d) { return d["@type"] === "Event"; });
        if (ld) {
          const debut = parseDate(ld.startDate);
          if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
          const price = ld.offers && ld.offers.price != null ? parseFloat(ld.offers.price) : null;
          events.push(normalize({
            id:          stableId(link.url),
            titre:       ld.name ?? link.titre,
            categories:  ld.genre ? [ld.genre] : [],
            source:      "3cket",
            date_debut:  debut,
            date_fin:    parseDate(ld.endDate),
            lieu:        ld.location && (ld.location.name ?? (ld.location.address && ld.location.address.addressLocality)),
            image:       Array.isArray(ld.image) ? ld.image[0] : ld.image,
            prix:        price != null ? { valeur: price, gratuit: price === 0 } : null,
            tickets_url: link.url,
            lien_detail: link.url,
            source_url:  SOURCE_URL,
          }));
          continue;
        }

        // Fallback HTML : titre dans <h1>, date/lieu dans les meta og ou texte structuré
        const titre = cleanText($d("h1").first().text()) || link.titre;
        const ogDesc = $d('meta[property="og:description"]').attr("content") || "";
        const ogImg  = $d('meta[property="og:image"]').attr("content");

        // 3cket page detail: "tomorrow, 6 Mayat10:00 PM" ou "Thursday, 7 Mayat8:30 AM"
        // Extraire depuis og:description ou body text
        const bodyText = cleanText($d("body").text()) || "";
        const dateMatchD = bodyText.match(/(\d{1,2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}|\w+day,\s+\d{1,2}\s+\w+|\d{1,2}\s+\w+\s+\d{4})/);
        const debut = parseDate(dateMatchD ? dateMatchD[1] : link.dateRaw);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;

        // Lieu : chercher patterns "at LIEU," ou "Location NAME"
        const lieuMatch = bodyText.match(/(?:at\s+|em\s+|Local\s*:?\s*)([A-Z][^\n,]{3,50})/);
        const lieu = lieuMatch ? cleanText(lieuMatch[1]) : null;

        if (!titre) continue;
        events.push(normalize({
          id:          stableId(link.url),
          titre,
          source:      "3cket",
          date_debut:  debut,
          lieu,
          image:       ogImg || null,
          tickets_url: link.url,
          lien_detail: link.url,
          source_url:  SOURCE_URL,
        }));
      } catch { /* ignorer les pages d'events individuels qui échouent */ }
    }
  } catch (e) { warn("3cket: " + e.message); }

  log("  3cket: " + events.length + " evenement(s)");
  return events;
}

// ============================================================
//  SCRAPER 4 — VIRAL AGENDA
//  robots.txt bloquant → on utilise leur sitemap XML
//  pour récupérer les URLs des events, puis on fetch
//  les pages individuelles qui retournent du JSON-LD.
// ============================================================

async function scrapeViralAgenda() {
  const SOURCE_URL = "https://www.viralagenda.com/pt";
  log("-> ViralAgenda");
  const events = [];

  // ViralAgenda bloque les User-Agents bots mais pas fetch standard
  // On tente l'API REST interne utilisée par leur SPA
  const HEADERS_VA = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Accept":     "application/json, text/plain, */*",
    "Referer":    "https://www.viralagenda.com/",
    "Origin":     "https://www.viralagenda.com",
  };

  try {
    // API interne mobile
    const apiUrls = [
      "https://www.viralagenda.com/api/v2/events?country_code=PT&page=1&per_page=50&upcoming=true",
      "https://www.viralagenda.com/api/events?locale=pt&country=PT&page=1&limit=50",
      "https://api.viralagenda.com/v1/events?country=PT&status=upcoming&per_page=50",
    ];

    let items = [];
    for (const apiUrl of apiUrls) {
      try {
        const res = await fetch(apiUrl, { headers: HEADERS_VA, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          items = data?.events ?? data?.data ?? data?.results ?? (Array.isArray(data) ? data : []);
          if (items.length) { log("  ViralAgenda API: " + items.length + " items"); break; }
        }
      } catch { /* essayer suivant */ }
    }

    if (items.length) {
      for (const ev of items) {
        const debut = parseDate(ev.start_date ?? ev.startDate ?? ev.date ?? ev.starts_at);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
        const price = ev.price ?? ev.min_price ?? ev.ticket_price;
        const url = ev.url ?? ev.link ?? (ev.slug ? "https://www.viralagenda.com/pt/" + ev.slug : null);
        events.push(normalize({
          id:          String(ev.id ?? stableId(url ?? ev.title)),
          titre:       ev.title ?? ev.name,
          categories:  ev.categories ? ev.categories.map(function(c) { return c.name ?? c; }) : [],
          source:      "ViralAgenda",
          date_debut:  debut,
          date_fin:    parseDate(ev.end_date ?? ev.endDate ?? ev.ends_at),
          lieu:        (ev.venue && ev.venue.name) ?? ev.location ?? ev.city,
          image:       ev.image ?? ev.thumbnail ?? ev.cover,
          prix:        price != null ? { valeur: parseFloat(price) || 0, gratuit: ev.is_free || price == 0 } : null,
          tickets_url: ev.ticket_url ?? url,
          lien_detail: url,
          source_url:  SOURCE_URL,
        }));
      }
    } else {
      // Fallback : parser la page HTML avec un UA mobile
      const res = await fetch(SOURCE_URL, { headers: HEADERS_VA, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const html = await res.text();
        const $ = cheerio.load(html);

        // JSON-LD
        const ld = extractJsonLD($).filter(function(d) { return d["@type"] === "Event"; });
        for (const ev of ld) {
          const debut = parseDate(ev.startDate);
          if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
          events.push(normalize({
            id: stableId(ev.url ?? ev.name), titre: ev.name, source: "ViralAgenda",
            date_debut: debut, date_fin: parseDate(ev.endDate),
            lieu: ev.location && ev.location.name,
            image: ev.image, lien_detail: ev.url, source_url: SOURCE_URL,
          }));
        }

        // Sélecteurs HTML
        if (!events.length) {
          $("article, .event-card, .event-item, [class*='event']").each(function(_, el) {
            const $el = $(el);
            const titre = cleanText($el.find("h1,h2,h3,[class*='title']").first().text());
            const url   = $el.find("a[href]").first().attr("href");
            const img   = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src");
            const dateRaw = $el.find("time,[class*='date']").first().attr("datetime") || $el.find("time,[class*='date']").first().text();
            if (!titre || titre.length < 3) return;
            const debut = parseDate(dateRaw);
            if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) return;
            events.push(normalize({ id: stableId(url || titre), titre, source: "ViralAgenda", date_debut: debut, lien_detail: url, image: img, source_url: SOURCE_URL }));
          });
        }
      }
    }
  } catch (e) { warn("ViralAgenda: " + e.message); }

  log("  ViralAgenda: " + events.length + " evenement(s)");
  return events;
}

// ============================================================
//  SCRAPER 5 — TURISMO DO CENTRO
//  Structure réelle : WordPress custom (pas The Events Calendar).
//  La page /agenda/ liste des liens /evento/SLUG.
//  Chaque page de detail a : date debut/fin en texte "DD.MM.YYYY",
//  lieu en "Morada / Localidade", image og:image.
//  Stratégie : parser la liste → visiter chaque detail.
// ============================================================

async function scrapeTurismoCentro() {
  const SOURCE_URL = "https://turismodocentro.pt/agenda/";
  log("-> Turismo do Centro");
  const events = [];

  try {
    const html = await fetchHTML(SOURCE_URL);
    const $ = cheerio.load(html);

    // Extraire tous les liens /evento/SLUG
    const eventLinks = [];
    const seen = new Set();
    $("a[href]").each(function(_, el) {
      const href = $(el).attr("href") || "";
      const m = href.match(/turismodocentro\.pt\/evento\/([^/?#]+)/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const titre = cleanText($(el).text()) || cleanText($(el).attr("title")) || m[1].replace(/-/g, " ");
      eventLinks.push({ slug: m[1], url: "https://turismodocentro.pt/evento/" + m[1] + "/", titre });
    });

    log("  TurismoCentro: " + eventLinks.length + " liens trouves");

    for (const link of eventLinks) {
      try {
        const dhtml = await fetchHTML(link.url);
        const $d = cheerio.load(dhtml);

        // JSON-LD
        const ld = extractJsonLD($d).find(function(d) { return d["@type"] === "Event"; });
        if (ld) {
          const debut = parseDate(ld.startDate);
          if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
          events.push(normalize({
            id: stableId(link.url), titre: ld.name || link.titre, source: "Turismo Centro Portugal",
            date_debut: debut, date_fin: parseDate(ld.endDate),
            lieu: ld.location && ld.location.name,
            image: ld.image, lien_detail: link.url, source_url: SOURCE_URL,
          }));
          continue;
        }

        // Scraping HTML de la page de detail
        // Date format: "DD.MM.YYYY" dans "Data de início" / "Data de fim"
        const bodyText = $d("body").text();
        const titre = cleanText($d("h1").first().text()) || link.titre;
        const img   = $d('meta[property="og:image"]').attr("content") || null;

        // Chercher "Data de início  DD.MM.YYYY"
        const debutMatch = bodyText.match(/Data de in[íi]cio\s+([\d.\/\-]+)/i);
        const finMatch   = bodyText.match(/Data de fim\s+([\d.\/\-]+)/i);

        const debut = parseDate(debutMatch ? debutMatch[1] : null);
        const fin   = parseDate(finMatch ? finMatch[1] : null);

        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;

        // Lieu : "Morada\n  LIEU\n  Localidade"
        const lieuBlock = $d(".tribe-venue-location, .location, address").first().text();
        const lieu = cleanText(lieuBlock) || null;

        events.push(normalize({
          id:          stableId(link.url),
          titre,
          source:      "Turismo Centro Portugal",
          date_debut:  debut,
          date_fin:    fin,
          lieu,
          image:       img,
          lien_detail: link.url,
          source_url:  SOURCE_URL,
        }));
      } catch { /* ignorer les pages de detail qui échouent */ }
    }
  } catch (e) { warn("TurismoCentro: " + e.message); }

  log("  TurismoCentro: " + events.length + " evenement(s)");
  return events;
}

// ============================================================
//  SCRAPER 6 — FESTAS E ARRAIAIS  (inchangé, fonctionnel)
// ============================================================

async function scrapeFestasArraiais() {
  const SOURCE_URL = "https://festasearraiais.pt/";
  log("-> Festas e Arraiais");
  const events = [];

  try {
    const html = await fetchHTML(SOURCE_URL);
    const $ = cheerio.load(html);

    // JSON-LD
    const ld = extractJsonLD($).filter(function(d) { return d["@type"] === "Event"; });
    for (const ev of ld) {
      const debut = parseDate(ev.startDate);
      if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
      events.push(normalize({
        id:          stableId(ev.url || ev.name),
        titre:       ev.name,
        categories:  ["Festa","Arraial"],
        source:      "FestasArraiais",
        date_debut:  debut,
        date_fin:    parseDate(ev.endDate),
        lieu:        ev.location && (ev.location.name || (ev.location.address && ev.location.address.addressLocality)),
        image:       ev.image,
        lien_detail: ev.url,
        source_url:  SOURCE_URL,
      }));
    }

    // Sélecteurs HTML
    if (!events.length) {
      $("article, .event, .festa-item, .event-card").each(function(_, el) {
        const $el = $(el);
        const titre = cleanText($el.find("h2,h3,.title,.event-title").first().text());
        const url   = $el.find("a[href]").first().attr("href");
        const img   = $el.find("img").first().attr("src") || $el.find("img").first().attr("data-src");
        const lieu  = cleanText($el.find(".location,.place,.venue,.localidade").first().text());
        const dateRaw = $el.find("time,.date,.data-evento").first().attr("datetime") || $el.find("time,.date,.data-evento").first().text();
        if (!titre || titre.length < 3) return;
        const debut = parseDate(dateRaw);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) return;
        events.push(normalize({ id: stableId(url || titre), titre, categories: ["Festa","Arraial"], source: "FestasArraiais", date_debut: debut, lieu, image: img, lien_detail: url, source_url: SOURCE_URL }));
      });
    }

    // Pagination
    const nextPage = $("a.next, .pagination a[rel='next']").attr("href");
    if (nextPage && events.length) {
      try {
        const html2 = await fetchHTML(nextPage);
        const $2 = cheerio.load(html2);
        extractJsonLD($2).filter(function(d) { return d["@type"] === "Event"; }).forEach(function(ev) {
          const debut = parseDate(ev.startDate);
          if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) return;
          events.push(normalize({ id: stableId(ev.url || ev.name), titre: ev.name, categories: ["Festa","Arraial"], source: "FestasArraiais", date_debut: debut, date_fin: parseDate(ev.endDate), lieu: ev.location && ev.location.name, image: ev.image, lien_detail: ev.url, source_url: SOURCE_URL }));
        });
      } catch { /* page 2 optionnelle */ }
    }
  } catch (e) { warn("FestasArraiais: " + e.message); }

  log("  FestasArraiais: " + events.length + " evenement(s)");
  return events;
}

// ============================================================
//  SCRAPER 7 — FEVERUP
//  Feverup est une SPA nécessitant une authentification app
//  et n'expose pas d'API publique accessible sans token.
//  Solution : scraper leur sitemap XML pour obtenir les URLs
//  des events, puis fetch chaque page (qui contient JSON-LD).
// ============================================================

async function scrapeFeverup() {
  const SOURCE_URL = "https://feverup.com/en/lisbon";
  log("-> Feverup");
  const events = [];

  // Feverup rend ses pages events avec JSON-LD quand on accède
  // directement a une URL d'event. On passe par leur sitemap.
  const SITEMAP_URLS = [
    "https://feverup.com/sitemap.xml",
    "https://feverup.com/sitemap-en-experiences.xml",
    "https://feverup.com/en-pt-experiences-sitemap.xml",
  ];

  let eventUrls = [];

  for (const sitemapUrl of SITEMAP_URLS) {
    try {
      const res = await fetch(sitemapUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/xml,text/xml,*/*" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      // Extraire les URLs /en/lisbon/ ou /en/porto/ ou /m/\d+
      const matches = [...xml.matchAll(/<loc>(https:\/\/feverup\.com\/(?:en\/(?:lisbon|porto)|m\/\d+)[^<]*)<\/loc>/g)];
      if (matches.length) {
        eventUrls = matches.map(function(m) { return m[1]; }).slice(0, 30);
        log("  Feverup sitemap: " + eventUrls.length + " URLs");
        break;
      }
    } catch { /* essayer suivant */ }
  }

  // Si pas de sitemap, tenter fetch direct de la page listing
  if (!eventUrls.length) {
    try {
      const html = await fetchHTML(SOURCE_URL);
      const $ = cheerio.load(html);
      // JSON-LD direct sur la page listing
      const ld = extractJsonLD($).filter(function(d) { return d["@type"] === "Event"; });
      for (const ev of ld) {
        const debut = parseDate(ev.startDate);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
        const price = ev.offers && ev.offers.price != null ? parseFloat(ev.offers.price) : null;
        events.push(normalize({
          id: stableId(ev.url || ev.name), titre: ev.name, source: "Feverup",
          date_debut: debut, date_fin: parseDate(ev.endDate),
          lieu: ev.location && ev.location.name,
          image: Array.isArray(ev.image) ? ev.image[0] : ev.image,
          prix: price != null ? { valeur: price, gratuit: price === 0 } : null,
          tickets_url: ev.url, lien_detail: ev.url, source_url: SOURCE_URL,
        }));
      }
      // Extraire liens /m/\d+ ou /en/event/
      const seen = new Set();
      $("a[href]").each(function(_, el) {
        const href = $(el).attr("href") || "";
        const m = href.match(/feverup\.com\/(m\/\d+|en\/[^/]+\/[^/?#]+)/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); eventUrls.push("https://feverup.com/" + m[1]); }
      });
      eventUrls = eventUrls.slice(0, 20);
    } catch { /* ignore */ }
  }

  // Visiter chaque URL d'event pour JSON-LD
  for (const url of eventUrls) {
    try {
      const dhtml = await fetchHTML(url);
      const $d = cheerio.load(dhtml);
      const ld = extractJsonLD($d).find(function(d) { return d["@type"] === "Event"; });
      if (!ld) continue;
      const debut = parseDate(ld.startDate);
      if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
      const price = ld.offers && ld.offers.price != null ? parseFloat(ld.offers.price) : null;
      events.push(normalize({
        id:          stableId(url),
        titre:       ld.name,
        source:      "Feverup",
        date_debut:  debut,
        date_fin:    parseDate(ld.endDate),
        lieu:        ld.location && (ld.location.name || (ld.location.address && ld.location.address.addressLocality)),
        image:       Array.isArray(ld.image) ? ld.image[0] : ld.image,
        prix:        price != null ? { valeur: price, gratuit: price === 0 } : null,
        tickets_url: ld.offers && ld.offers.url || url,
        lien_detail: url,
        source_url:  SOURCE_URL,
      }));
    } catch { /* ignorer */ }
  }

  log("  Feverup: " + events.length + " evenement(s)");
  return events;
}

// ============================================================
//  SCRAPER 8 — TICKETLINE
//  Structure réelle : les events sont chargés dynamiquement
//  par JavaScript — le HTML brut ne contient pas les events.
//  Solution : scraper les pages /agenda/YYYY/MM (HTML statique
//  qui retourne la liste des events avec leurs URLs).
//  Les pages /espetaculo/SLUG contiennent JSON-LD complet.
// ============================================================

async function scrapeTicketline() {
  const SOURCE_URL = "https://www.ticketline.pt/";
  log("-> Ticketline");
  const events = [];

  // Ticketline a des pages agenda par mois avec HTML statique
  const now = new Date();
  const months = [
    { y: now.getFullYear(), m: now.getMonth() + 1 },
    { y: now.getFullYear(), m: now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2 },
  ];
  // Corriger l'année si passage en janvier
  if (months[1].m === 1 && months[0].m === 12) months[1].y = now.getFullYear() + 1;

  const eventLinks = [];
  const seen = new Set();

  for (const mo of months) {
    const agendaUrl = "https://www.ticketline.pt/agenda/" + mo.y + "/" + mo.m;
    try {
      const html = await fetchHTML(agendaUrl, { "Referer": "https://www.ticketline.pt/" });
      const $ = cheerio.load(html);

      // Ticketline : les events sont dans des <a href="/espetaculo/SLUG">
      $("a[href*='/espetaculo/'], a[href*='/bilhetes/']").each(function(_, el) {
        const href = $(el).attr("href") || "";
        const absUrl = href.startsWith("http") ? href : "https://www.ticketline.pt" + href;
        if (seen.has(absUrl)) return;
        seen.add(absUrl);
        const titre = cleanText($(el).text()) || cleanText($(el).attr("title"));
        if (titre && titre.length > 2) eventLinks.push({ url: absUrl, titre });
      });

      // JSON-LD sur la page agenda
      const ld = extractJsonLD($).filter(function(d) { return d["@type"] === "Event"; });
      for (const ev of ld) {
        if (seen.has(ev.url)) continue;
        seen.add(ev.url);
        const debut = parseDate(ev.startDate);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
        const price = ev.offers && ev.offers.price != null ? parseFloat(ev.offers.price) : null;
        events.push(normalize({
          id: stableId(ev.url || ev.name), titre: ev.name,
          categories: ev.genre ? [ev.genre] : [], source: "Ticketline",
          date_debut: debut, date_fin: parseDate(ev.endDate),
          lieu: ev.location && ev.location.name,
          image: ev.image,
          prix: price != null ? { valeur: price, gratuit: price === 0 } : null,
          tickets_url: ev.offers && ev.offers.url || ev.url, lien_detail: ev.url, source_url: SOURCE_URL,
        }));
      }
    } catch (e) { warn("Ticketline agenda " + mo.y + "/" + mo.m + ": " + e.message); }
  }

  log("  Ticketline: " + eventLinks.length + " liens + " + events.length + " JSON-LD");

  // Visiter les pages de detail pour les events sans JSON-LD (limité a 25)
  const limit = Math.min(eventLinks.length, 25);
  for (let i = 0; i < limit; i++) {
    const link = eventLinks[i];
    try {
      const dhtml = await fetchHTML(link.url, { "Referer": "https://www.ticketline.pt/agenda" });
      const $d = cheerio.load(dhtml);
      const ld = extractJsonLD($d).find(function(d) { return d["@type"] === "Event"; });
      if (ld) {
        const debut = parseDate(ld.startDate);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
        const price = ld.offers && ld.offers.price != null ? parseFloat(ld.offers.price) : null;
        if (!seen.has(link.url + "_detail")) {
          seen.add(link.url + "_detail");
          events.push(normalize({
            id: stableId(link.url), titre: ld.name || link.titre,
            categories: ld.genre ? [ld.genre] : [], source: "Ticketline",
            date_debut: debut, date_fin: parseDate(ld.endDate),
            lieu: ld.location && ld.location.name,
            image: ld.image,
            prix: price != null ? { valeur: price, gratuit: price === 0 } : null,
            tickets_url: ld.offers && ld.offers.url || link.url,
            lien_detail: link.url, source_url: SOURCE_URL,
          }));
        }
        continue;
      }

      // Fallback HTML : Ticketline a des meta og: structurées
      const titre = cleanText($d("h1, h2.titulo").first().text()) || link.titre;
      const img   = $d('meta[property="og:image"]').attr("content") || null;
      const dateRaw = cleanText($d(".data, .date, time").first().text());
      const lieu  = cleanText($d(".local, .sala, .venue").first().text());
      const debut = parseDate(dateRaw);
      if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
      if (!titre) continue;
      events.push(normalize({
        id: stableId(link.url), titre, source: "Ticketline",
        date_debut: debut, lieu, image: img,
        tickets_url: link.url, lien_detail: link.url, source_url: SOURCE_URL,
      }));
    } catch { /* ignorer */ }
  }

  log("  Ticketline total: " + events.length + " evenement(s)");
  return events;
}

// ============================================================
//  SCRAPER 9 — AONDEVAMOS
//  Structure réelle : WordPress custom, HTML entièrement
//  rendu côté serveur. Page /esta-semana/ liste les events
//  avec liens /VILLE/CATEGORIE/SLUG. Chaque page de detail
//  a : date "DD/MM/YYYY", lieu "LOCAL\nVILLE", og:image.
// ============================================================

async function scrapeAondeVamos() {
  const SOURCE_URL = "https://aondevamos.pt/";
  log("-> AondeVamos");
  const events = [];
  const seen = new Set();

  // Pages de listing avec des events
  const LISTING_PAGES = [
    "https://aondevamos.pt/esta-semana/",
    "https://aondevamos.pt/este-mes/",
    "https://aondevamos.pt/",
  ];

  const eventLinks = [];

  for (const pageUrl of LISTING_PAGES) {
    try {
      const html = await fetchHTML(pageUrl);
      const $ = cheerio.load(html);

      // Extraire les liens d'events : /VILLE/CATEGORIE/SLUG/
      $("a[href]").each(function(_, el) {
        const href = $(el).attr("href") || "";
        // Pattern: https://aondevamos.pt/porto/feiras-e-mercados/mercado-da-batalha/
        const m = href.match(/^https:\/\/aondevamos\.pt\/([^/]+\/[^/]+\/[^/]+)\/?$/);
        if (!m) return;
        // Exclure les pages de navigation (aujourd-hui, esta-semana, etc.)
        const slug = m[1];
        if (/^(hoje|amanha|esta-semana|este-mes|este-fim-de-semana|festas|festivais|concertos)/.test(slug)) return;
        if (seen.has(slug)) return;
        seen.add(slug);
        const titre = cleanText($(el).text()) || slug.split("/").pop().replace(/-/g, " ");
        if (titre.length < 3) return;
        eventLinks.push({ url: href.endsWith("/") ? href : href + "/", titre });
      });
    } catch (e) { warn("AondeVamos listing " + pageUrl + ": " + e.message); }
  }

  log("  AondeVamos: " + eventLinks.length + " liens trouves");

  // Visiter chaque page de detail (limité a 40)
  const limit = Math.min(eventLinks.length, 40);
  for (let i = 0; i < limit; i++) {
    const link = eventLinks[i];
    try {
      const dhtml = await fetchHTML(link.url);
      const $d = cheerio.load(dhtml);

      // JSON-LD
      const ld = extractJsonLD($d).find(function(d) { return d["@type"] === "Event"; });
      if (ld) {
        const debut = parseDate(ld.startDate);
        if (CONFIG.SKIP_PAST_EVENTS && isPast(debut)) continue;
        events.push(normalize({
          id: stableId(link.url), titre: ld.name || link.titre, source: "AondeVamos",
          date_debut: debut, date_fin: parseDate(ld.endDate),
          lieu: ld.location && (ld.location.name || (ld.location.address && ld.location.address.addressLocality)),
          image: ld.image,
          prix: { valeur: null, gratuit: (ld.offers && ld.offers.price == 0) || false },
          lien_detail: link.url, source_url: SOURCE_URL,
        }));
        continue;
      }

      // Fallback HTML : AondeVamos structure connue
      const titre = cleanText($d("h1").first().text()) || link.titre;
      const img   = $d('meta[property="og:image"]').attr("content") || null;

      // Date : "DATA\n06/05/2026"
      const bodyText = $d("body").text();
      const dateMatch = bodyText.match(/DATA\s+([\d\/]+)/i) || bodyText.match(/(\d{2}\/\d{2}\/\d{4})/);
      const debut = parseDate(dateMatch ? dateMatch[1] : null);

      // Lieu : "LOCAL\nNOM DU LIEU, VILLE"
      const lieuMatch = bodyText.match(/LOCAL\s+([^\n]{3,80})/i);
      const lieu = lieuMatch ? cleanText(lieuMatch[1]) : null;

      // Prix : "Entrada Livre" ou absence
      const gratuit = /Entrada Livre/i.test(bodyText);

      if (CONFIG.SKIP_PAST_EVENTS && isPast(debut) && debut !== null) continue;
      if (!titre) continue;

      events.push(normalize({
        id:          stableId(link.url),
        titre,
        source:      "AondeVamos",
        date_debut:  debut,
        lieu,
        image:       img,
        prix:        { valeur: gratuit ? 0 : null, gratuit },
        lien_detail: link.url,
        source_url:  SOURCE_URL,
      }));
    } catch { /* ignorer */ }
  }

  log("  AondeVamos: " + events.length + " evenement(s)");
  return events;
}

//  ORCHESTRATEUR — Lance tous les scrapers
// ============================================================

async function scrapeAll() {
  const scrapers = [
    CONFIG.SCRAPERS.coimbra        && { name: "Coimbra",        fn: scrapeCoimbra },
    CONFIG.SCRAPERS.eventbrite     && { name: "Eventbrite",     fn: scrapeEventbrite },
    CONFIG.SCRAPERS.trecket        && { name: "3cket",          fn: scrape3cket },
    CONFIG.SCRAPERS.viralagenda    && { name: "ViralAgenda",    fn: scrapeViralAgenda },
    CONFIG.SCRAPERS.turismo_centro && { name: "TurismoCentro",  fn: scrapeTurismoCentro },
    CONFIG.SCRAPERS.festasarraiais && { name: "FestasArraiais", fn: scrapeFestasArraiais },
    CONFIG.SCRAPERS.feverup        && { name: "Feverup",        fn: scrapeFeverup },
    CONFIG.SCRAPERS.ticketline     && { name: "Ticketline",     fn: scrapeTicketline },
    CONFIG.SCRAPERS.aondevamos     && { name: "AondeVamos",     fn: scrapeAondeVamos },
  ].filter(Boolean);

  const allEvents = [];
  const results   = {};

  for (const { name, fn } of scrapers) {
    try {
      const events = await fn();
      const limited = CONFIG.MAX_EVENTS > 0 ? events.slice(0, CONFIG.MAX_EVENTS) : events;
      allEvents.push(...limited);
      results[name] = { ok: true, count: limited.length };
    } catch (err) {
      warn(`Scraper ${name} a échoué : ${err.message}`);
      results[name] = { ok: false, error: err.message };
    }
  }

  // Dédoublonnage global par (titre + date_debut) — cas de syndication croisée
  const deduped = [];
  const seenKey  = new Set();
  for (const ev of allEvents) {
    const key = `${ev.titre?.toLowerCase()?.slice(0,40)}|${ev.date_debut?.slice(0,10)}`;
    if (seenKey.has(key)) { log(`Doublon ignoré : ${ev.titre} (${ev.source})`); continue; }
    seenKey.add(key);
    deduped.push(ev);
  }

  return { events: deduped, results };
}

// ============================================================
//  GÉNÉRATION DE L'INDEX
//  Produit data/index.json — tableau trié par date_debut
//  contenant les champs essentiels de chaque événement.
//  Le site web consomme cet index pour afficher les listings
//  sans avoir à lire les 100+ fichiers individuels.
// ============================================================

/**
 * Construit et retourne l'objet index complet.
 * Structure :
 * {
 *   generated_at : "YYYY-MM-DDTHH:MM:SS",
 *   total        : 123,
 *   sources      : { "Eventbrite": 74, "Coimbra": 15, ... },
 *   events       : [
 *     {
 *       id, titre, source, date_debut, date_fin,
 *       lieu, image, gratuit, lien_detail, tickets_url
 *     },
 *     ...  // trié par date_debut ASC, null en dernier
 *   ]
 * }
 */
function buildIndex(events, scrapeResults) {
  // Résumé par source
  const sources = {};
  for (const [name, r] of Object.entries(scrapeResults)) {
    if (r.ok) sources[name] = r.count;
  }

  // Projection légère : uniquement les champs utiles au listing web
  const items = events.map(ev => ({
    id:          ev.id,
    titre:       ev.titre,
    source:      ev.source,
    date_debut:  ev.date_debut,
    date_fin:    ev.date_fin   ?? null,
    ongoing:     ev.ongoing    ?? false,
    lieu:        ev.lieu       ?? null,
    image:       ev.image      ?? null,
    gratuit:     ev.prix?.gratuit ?? null,
    prix_valeur: ev.prix?.valeur  ?? null,
    categories:  ev.categories ?? [],
    lien_detail: ev.lien_detail ?? null,
    tickets_url: ev.tickets_url ?? null,
  }));

  // Tri par date_debut ASC — null/undefined poussés en fin
  items.sort((a, b) => {
    if (!a.date_debut && !b.date_debut) return 0;
    if (!a.date_debut) return 1;
    if (!b.date_debut) return -1;
    return a.date_debut.localeCompare(b.date_debut);
  });

  return {
    generated_at: new Date().toISOString().slice(0, 19),
    total:        items.length,
    sources,
    events:       items,
  };
}

// ============================================================
//  SAUVEGARDE LOCALE — 1 fichier JSON par événement + index
// ============================================================

async function saveLocally(events, scrapeResults) {
  // Écrit directement dans OUTPUT_DIR (chemin absolu sur le serveur)
  await mkdir(CONFIG.OUTPUT_DIR, { recursive: true });

  // Fichiers individuels
  for (const ev of events) {
    const path = join(CONFIG.OUTPUT_DIR, `${ev.id}.json`);
    await writeFile(path, JSON.stringify(ev, null, 2), "utf8");
    log(`Sauvegardé : ${path}`);
  }

  // Index global
  const index = buildIndex(events, scrapeResults);
  const indexPath = join(CONFIG.OUTPUT_DIR, "index.json");
  await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");

  console.log(`\n💾 ${events.length} fichier(s) JSON → ${CONFIG.OUTPUT_DIR}/`);
  console.log(`📑 Index → ${indexPath}  (${index.total} events, trié par date)`);
  console.log(`   Accessible via : /scraped_events/index.json`);
}



// ============================================================
//  POINT D'ENTRÉE
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   MULTI-SITE EVENT SCRAPER — 9 sources                  ║");
  console.log("║   Licence MIT — GAFAM free                              ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  try {
    console.log("🔍 Scraping en cours...\n");
    const { events, results } = await scrapeAll();

    console.log("\n📊 Résultats par source :");
    for (const [name, r] of Object.entries(results)) {
      if (r.ok) console.log(`   ✓ ${name.padEnd(16)} ${r.count} événement(s)`);
      else      console.log(`   ✗ ${name.padEnd(16)} ERREUR : ${r.error}`);
    }

    console.log(`\n📋 Total : ${events.length} événement(s) uniques`);

    if (!events.length) {
      console.warn("⚠️  Aucun événement récupéré. Vérifiez la connexion et les sites cibles.");
      return;
    }

    // Aperçu
    console.log("\n📋 Aperçu — premier événement :");
    console.log(JSON.stringify(events[0], null, 2));

    // Sauvegarde locale
    await saveLocally(events, results);

    console.log("\n✅ Scrape terminé. Les fichiers sont disponibles dans :");
    console.log("   " + CONFIG.OUTPUT_DIR);

  } catch (err) {
    console.error("\n❌ Erreur critique :", err.message);
    if (CONFIG.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
