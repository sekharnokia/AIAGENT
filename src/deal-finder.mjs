import fs from "node:fs/promises";

const STORES = [
  { name: "Walmart", domain: "walmart.com" },
  { name: "Target", domain: "target.com" },
  { name: "Carter's", domain: "carters.com" },
  { name: "Old Navy", domain: "oldnavy.gap.com" },
  { name: "The Children's Place", domain: "childrensplace.com" },
];
const MAX_PRICE = 100;
const STATE_PATH = "data/seen.json";
const MAX_ALERTS_PER_RUN = 12;
const TIME_ZONE = "America/New_York";

function localHourAndDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function decodeHtml(s = "") {
  return s.replaceAll("&amp;", "&").replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
function asArray(x) { return Array.isArray(x) ? x : x ? [x] : []; }
function walkProducts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const v of node) walkProducts(v, out); return out; }
  const types = asArray(node["@type"]);
  if (types.some(t => String(t).toLowerCase() === "product")) out.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkProducts(value, out);
  }
  return out;
}
function parseJsonLd(html) {
  const docs = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try { docs.push(JSON.parse(match[1].trim())); } catch {}
  }
  return docs.flatMap(d => walkProducts(d));
}
function offerList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(offerList);
  if (value["@type"] === "AggregateOffer") return offerList(value.offers);
  return [value];
}
function sizeText(v) {
  return [v?.size, v?.name, v?.sku, v?.description]
    .filter(Boolean).join(" ").toUpperCase();
}
function isTargetSize(v) {
  return /(^|[^A-Z0-9])(3T|4T|3 TODDLER|4 TODDLER|3 YEARS?|4 YEARS?)([^A-Z0-9]|$)/i.test(sizeText(v));
}
function priceOf(offer) {
  const raw = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price;
  const n = Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function isInStock(offer) {
  return /InStock|LimitedAvailability/i.test(String(offer?.availability ?? ""));
}
function verifyPage(html, fallbackTitle, url) {
  const products = parseJsonLd(html);
  for (const p of products) {
    const variants = [...asArray(p.hasVariant), ...asArray(p.model), p];
    for (const v of variants) {
      const offers = offerList(v.offers ?? v.offers?.offers);
      for (const offer of offers) {
        const sizeVerified = isTargetSize(v) || isTargetSize(offer);
        const price = priceOf(offer);
        if (!sizeVerified || price === null || price >= MAX_PRICE || !isInStock(offer)) continue;
        const title = decodeHtml(v.name || p.name || fallbackTitle || "Kids clothing item").slice(0, 150);
        const retailer = STORES.find(s => new URL(url).hostname.toLowerCase().endsWith(s.domain));
        if (!retailer) continue;
        return { title, price, size: sizeText(v) || sizeText(offer), retailer: retailer.name, url };
      }
    }
  }
  return null;
}
function stableUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|source|ref)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = "";
    return u.toString();
  } catch { return null; }
}
function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
async function tavilySearch(domain) {
  const query = `kids toddler clothing 3T 4T under $100 in stock add to cart size variants shirts tops pants shorts dresses pajamas clearance ${domain}`;
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 15,
      include_domains: [domain],
      topic: "general"
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`Tavily search failed (${response.status})`);
  const data = await response.json();
  return data.results ?? [];
}
async function verifyResult(result, store) {
  const url = stableUrl(result.url);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; KidsDealFinder/1.0; +https://github.com/sekharnokia/AIAGENT)",
        "accept": "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) return null;
    const finalUrl = stableUrl(response.url);
    if (!finalUrl || !new URL(finalUrl).hostname.toLowerCase().endsWith(store.domain)) return null;
    const html = (await response.text()).slice(0, 3_000_000);
    return verifyPage(html, result.title, finalUrl);
  } catch (err) {
    console.log(`Skipping page that could not be verified: ${url} (${err.message})`);
    return null;
  }
}
async function sendTelegram(items) {
  const chunks = [];
  let current = "";
  for (const item of items) {
    const message = [
      `<b>${escapeHtml(item.title)}</b>`,
      `Store: ${escapeHtml(item.retailer)}`,
      `Price: <b>$${item.price.toFixed(2)}</b>`,
      `Size: ${escapeHtml(item.size)}`,
      `<a href="${escapeHtml(item.url)}">Shop product</a>`
    ].join("\n");
    if (current && current.length + message.length + 3 > 3800) {
      chunks.push(current); current = "";
    }
    current += (current ? "\n\n" : "") + message;
  }
  if (current) chunks.push(current);
  for (const text of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false
      }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Telegram delivery failed");
  }
}

async function main() {
  for (const key of ["TAVILY_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
  }
  const now = localHourAndDate();
  const hour = Number(now.hour);
  const isManualRun = ["workflow_dispatch", "push"].includes(process.env.GITHUB_EVENT_NAME);
  if (!isManualRun && ![9, 18].includes(hour)) {
    console.log(`Outside the 9 AM / 6 PM Eastern alert windows (${now.hour}:xx ET); safely skipping this UTC trigger.`);
    return;
  }
  if (isManualRun) console.log("Manual or code-update test run requested; searching and sending any newly verified qualifying deals.");

  let state = { seen: {} };
  try { state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")); } catch {}
  state.seen ??= {};

  const verified = new Map();
  for (const store of STORES) {
    console.log(`Searching ${store.name}...`);
    const results = await tavilySearch(store.domain);
    for (const result of results) {
      const candidate = await verifyResult(result, store);
      if (candidate && !state.seen[candidate.url]) verified.set(candidate.url, candidate);
    }
  }

  const fresh = [...verified.values()].slice(0, MAX_ALERTS_PER_RUN);
  if (!fresh.length) {
    console.log(`No newly verified deals under ${MAX_PRICE} with an in-stock 3T/4T variant. Staying quiet.`);
    return;
  }

  await sendTelegram(fresh);
  const timestamp = new Date().toISOString();
  for (const item of fresh) state.seen[item.url] = { firstSeen: timestamp, price: item.price };
  const entries = Object.entries(state.seen);
  if (entries.length > 3000) state.seen = Object.fromEntries(entries.slice(-3000));
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(`Sent ${fresh.length} new verified deal(s).`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
