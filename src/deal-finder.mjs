import fs from "node:fs/promises";

const API_BASE = "https://api.steadyapi.com/v1/walmart";
const TARGET_SIZE = "3T";
const MAX_PRICE = 10;
const STATE_PATH = "data/seen.json";
const MAX_DETAILS_PER_RUN = 3; // 1 seeded item + at most 2 search results; stay within the free monthly request budget
const TIME_ZONE = "America/New_York";

function localHourAndDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function stableUrl(raw, id) {
  try {
    const u = new URL(raw || `https://www.walmart.com/ip/${id}`);
    if (u.hostname !== "walmart.com" && !u.hostname.endsWith(".walmart.com")) return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function walmartApi(path, params = {}) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.WALMART_API_KEY}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || data.error || response.statusText;
    throw new Error(`SteadyAPI ${path} failed (${response.status}): ${detail}`);
  }
  if (data.meta?.status && Number(data.meta.status) >= 400) {
    throw new Error(`SteadyAPI ${path}: ${data.message || data.meta.status}`);
  }
  return data.body;
}

function optionEntries(options) {
  if (Array.isArray(options)) {
    return options.map(option => [
      String(option?.name ?? option?.label ?? option?.key ?? ""),
      String(option?.value ?? option?.displayValue ?? option?.label ?? "")
    ]);
  }
  if (options && typeof options === "object") {
    return Object.entries(options).map(([key, value]) => [
      key, String(value?.value ?? value?.name ?? value)
    ]);
  }
  return [];
}

function getSizeFromVariant(variant) {
  const entries = optionEntries(variant?.options ?? variant?.optionValues ?? variant?.attributes);
  for (const [key, value] of entries) {
    if (/size/i.test(key) && /(^|[^A-Z0-9])3T([^A-Z0-9]|$)/i.test(value)) return value;
  }
  const fallback = [
    variant?.size, variant?.sizeName, variant?.sizeValue,
    variant?.name, variant?.title, variant?.label
  ].filter(Boolean).join(" ");
  return /(^|[^A-Z0-9])3T([^A-Z0-9]|$)/i.test(fallback) ? fallback : null;
}

function inStock(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return /IN_STOCK|AVAILABLE|LIMITED_AVAILABILITY|INSTOCK/i.test(String(value))
    && !/OUT_OF_STOCK|UNAVAILABLE|SOLD_OUT/i.test(String(value));
}

function verifiedDeal(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  for (const variant of variants) {
    const size = getSizeFromVariant(variant);
    const price = Number(variant.price ?? variant.currentPrice ?? product.price);
    const availability = variant.availability ?? variant.availabilityStatus;
    if (!size || !Number.isFinite(price) || price <= 0 || price >= MAX_PRICE || !inStock(availability)) continue;
    const url = stableUrl(product.url, product.id);
    if (!url) continue;
    return {
      title: product.title || "Walmart kids clothing",
      retailer: "Walmart",
      price,
      size: TARGET_SIZE,
      url,
      id: String(product.id)
    };
  }
  return null;
}

async function searchProducts() {
  const body = await walmartApi("search", {
    q: "toddler kids clothing 3T",
    maxPrice: MAX_PRICE,
    sort: "price_low",
    page: 1
  });
  return Array.isArray(body?.items) ? body.items : [];
}

async function getProductDetails(ids) {
  // SteadyAPI batch endpoint returns full details for up to five items in one
  // weighted request, preserving the order of the submitted IDs.
  const body = await walmartApi("products/batch", { ids: ids.join(",") });
  return Array.isArray(body) ? body : [];
}

function summarizeVariantData(product) {
  const variants = product?.variants;
  const shallowShape = (value, depth = 0) => {
    if (value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.slice(0, 5).map(x => shallowShape(x, depth + 1));
    if (depth >= 3) return "[nested object]";
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, child]) => [
      key, child && typeof child === "object" ? shallowShape(child, depth + 1) : child
    ]));
  };
  return {
    variantsType: Array.isArray(variants) ? "array" : typeof variants,
    variantKeys: variants && typeof variants === "object" ? Object.keys(variants).slice(0, 30) : [],
    variantsShape: shallowShape(variants),
    productPrice: product?.price ?? null,
    productAvailability: product?.availability ?? null,
    priceRange: product?.priceRange ?? null,
    sizeSpecifications: (Array.isArray(product?.specifications) ? product.specifications : [])
      .filter(x => /size/i.test(String(x?.name ?? ""))).slice(0, 10)
  };
}

async function sendTelegram(items) {
  const messages = items.map(item => [
    `<b>${escapeHtml(item.title)}</b>`,
    "Store: Walmart",
    `Price: <b>$${item.price.toFixed(2)}</b>`,
    `Size: ${TARGET_SIZE} (in stock)`,
    `<a href="${escapeHtml(item.url)}">Shop product</a>`
  ].join("\n"));
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: messages.join("\n\n"),
      parse_mode: "HTML",
      disable_web_page_preview: false
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram delivery failed: ${data.description || response.status}`);
}

async function main() {
  for (const key of ["WALMART_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (!process.env[key]) throw new Error(`Missing required secret: ${key}`);
  }

  const now = localHourAndDate();
  const hour = Number(now.hour);
  const isManualRun = ["workflow_dispatch", "push"].includes(process.env.GITHUB_EVENT_NAME);
  if (!isManualRun && ![9, 18].includes(hour)) {
    console.log(`Outside the 9 AM / 6 PM Eastern alert windows (${now.hour}:xx ET); safely skipping this UTC trigger.`);
    return;
  }
  if (isManualRun) console.log("Manual or code-update test run: querying SteadyAPI Walmart catalog.");

  let state = { seen: {} };
  try { state = JSON.parse(await fs.readFile(STATE_PATH, "utf8")); } catch {}
  state.seen ??= {};

  console.log("Searching Walmart for toddler/kids clothing under $10...");
  const listings = await searchProducts();
  console.log(`SteadyAPI returned ${listings.length} listing(s) on page 1.`);

  const byId = new Map();
  // Always test the product the user confirmed is available in size 3T.
  byId.set("20172702440", {
    id: "20172702440",
    title: "Garanimals Baby & Toddler Girl Dress 2-Piece Outfit Set",
    url: "https://www.walmart.com/ip/Garanimals-Baby-Toddler-Girl-Dress-2-Piece-Outfit-Set-Sizes-0-6T/20172702440"
  });

  for (const item of listings) {
    if (!item?.id || byId.size >= MAX_DETAILS_PER_RUN) continue;
    if (!/(shirt|top|pant|short|dress|legging|outfit|clothing|pajama|toddler|kids)/i.test(item.title || "")) continue;
    if (item.isPreowned === true) continue;
    byId.set(String(item.id), item);
  }

  console.log(`Fetching detailed variant data for ${byId.size} product(s).`);
  const verified = [];
  const ids = [...byId.keys()];
  let detailRows = [];
  try {
    detailRows = await getProductDetails(ids);
    console.log(`SteadyAPI batch detail response contained ${detailRows.length} product record(s).`);
  } catch (error) {
    console.log(`Batch details request failed: ${error.message}`);
  }

  const detailById = new Map(detailRows.map(product => [String(product?.id ?? ""), product]));
  for (const [id, listing] of byId) {
    const product = detailById.get(id);
    if (!product || product.error) {
      console.log(`Could not verify product ${id}: ${product?.error || "missing from batch response"}`);
      continue;
    }
    const merged = { ...listing, ...product, id: String(product?.id || id) };
    const deal = verifiedDeal(merged);
    if (deal) {
      const previous = state.seen[deal.url];
      if (!previous || Number(previous.price) > deal.price) verified.push(deal);
      console.log(`Verified ${deal.title}: ${deal.price.toFixed(2)} in size ${TARGET_SIZE}.`);
    } else {
      // Diagnostic only: never logs credentials or the full product payload.
      console.log(`Variant diagnostics for ${listing.title || id}: ${JSON.stringify(summarizeVariantData(merged))}`);
      console.log(`Not eligible: no verified in-stock ${TARGET_SIZE} variant below ${MAX_PRICE}.`);
    }
  }

  const fresh = verified.slice(0, 10);
  if (!fresh.length) {
    console.log(`No newly verified Walmart deals below $${MAX_PRICE} with an in-stock ${TARGET_SIZE} variant. Staying quiet.`);
    return;
  }

  await sendTelegram(fresh);
  const timestamp = new Date().toISOString();
  for (const item of fresh) state.seen[item.url] = { firstSeen: timestamp, price: item.price };
  const entries = Object.entries(state.seen);
  if (entries.length > 3000) state.seen = Object.fromEntries(entries.slice(-3000));
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(`Telegram accepted ${fresh.length} new Walmart ${TARGET_SIZE} deal(s) under $${MAX_PRICE}.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
