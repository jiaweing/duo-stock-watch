// Duo Stock Watch: a tiny local server that checks Apple Store pickup stock for iPhone Duo
// and serves one page showing what is in stock right now. No dependencies.
//
//   node server.mjs        then open http://localhost:4173
//
// The browser cannot read apple.com directly (cross-origin), so this process does the
// checking and the page reads the result from it.

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const CONFIG_FILE = join(HERE, "config.json");

// Apple publishes no limit for this endpoint. Other people's checkers report blocks (HTTP 541) at
// roughly 4 to 6 requests a minute and within an hour at one request every 30 seconds, while one
// request every 45 to 120 seconds has run for hours. So: once every 60 to 75 seconds, with jitter.
const everyMs = () => 60_000 + Math.random() * 15_000;
const MIN_GAP_MS = 20_000; // never hit Apple more often than this, whatever happens
const BLOCKED_MIN = [15, 30, 45]; // minutes to wait after each block in a row
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// Part numbers come from each country's own iPhone Duo buy page on apple.com.
// Config names and store names are read from Apple's reply.
const X = "MK2D4_ MK2E4_ MK2F4_ MK2G4_ MK2H4_ MK2J4_ MK2K4_ MK2L4_";
const J = "MK244_ MK254_ MK264_ MK274_ MK284_ MK294_ MK2A4_ MK2C4_";
const parts = (tpl, suffix) => tpl.split(" ").map((p) => p.replace("_", `${suffix}/A`));
const COUNTRIES = {
  sg: { name: "Singapore", path: "/sg", parts: parts(X, "X"), place: "238801" },
  my: { name: "Malaysia", path: "/my", parts: parts(X, "X"), place: "55100" },
  hk: { name: "Hong Kong", path: "/hk", parts: parts(X, "ZA"), place: "Central" },
  tw: { name: "Taiwan", path: "/tw", parts: parts(X, "ZP"), place: "110" },
  th: { name: "Thailand", path: "/th", parts: parts(X, "ZP"), place: "10330" },
  jp: { name: "Japan", path: "/jp", parts: parts(J, "J"), place: "100-0005", big: true },
  kr: { name: "South Korea", path: "/kr", parts: parts(X, "KH"), place: "06021", big: true },
  in: { name: "India", path: "/in", parts: parts(X, "HN"), place: "400051", big: true },
  au: { name: "Australia", path: "/au", parts: parts(X, "X"), place: "2000", big: true },
  ae: { name: "UAE", path: "/ae", parts: parts(J, "AH"), place: "Dubai" },
  uk: { name: "United Kingdom", path: "/uk", parts: parts(X, "QN"), place: "W1B 2EL", big: true },
  de: { name: "Germany", path: "/de", parts: parts(X, "ZD"), place: "10117", big: true },
  fr: { name: "France", path: "/fr", parts: parts(X, "F"), place: "75001", big: true },
  ca: { name: "Canada", path: "/ca", parts: parts(J, "VC"), place: "M5H 2N2", big: true },
  us: {
    name: "United States",
    path: "",
    parts: "MK1E4LL/A MK1F4LL/A MK1G4LL/A MK1H4LL/A MK1J4LL/A MK1L4LL/A MK1Q4LL/A MK1R4LL/A".split(" "),
    place: "10001",
    big: true,
  },
};

let config = { country: "sg", places: {} };
try {
  const saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  if (COUNTRIES[saved.country]) config = { country: saved.country, places: saved.places ?? {} };
} catch {
  // No saved config yet: start with Singapore.
}

const country = () => COUNTRIES[config.country];
const place = () => config.places[config.country] || country().place;
const buyUrl = () => `https://www.apple.com${country().path}/shop/buy-iphone/iphone-duo`;
const stockUrl = () =>
  `https://www.apple.com${country().path}/shop/retail/pickup-message?pl=true&` +
  country()
    .parts.map((p, i) => `parts.${i}=${encodeURIComponent(p)}`)
    .join("&") +
  `&location=${encodeURIComponent(place())}`;

// status: "checking" | "ok" | "blocked" | "no_stores" | "error"
let state = { status: "checking", found: [], stores: [], checkedAt: 0, nextAt: 0 };
let seen = new Set();
let blocksInARow = 0;
let lastHit = 0;
let generation = 0;
let timer;
let cookie = "";

// Apple's shop sets cookies on the buy page; send them back like a browser would.
async function refreshCookie() {
  try {
    const res = await fetch(buyUrl(), { headers: { "user-agent": UA, accept: "text/html" } });
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  } catch {
    cookie = "";
  }
}

async function askApple() {
  lastHit = Date.now();
  const res = await fetch(stockUrl(), {
    headers: {
      "user-agent": UA,
      accept: "application/json, text/plain, */*",
      "accept-language": "en",
      referer: buyUrl(),
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!res.ok) return { blocked: true, httpStatus: res.status };
  let json;
  try {
    json = await res.json();
  } catch {
    return { blocked: true, httpStatus: res.status };
  }
  const stores = json?.body?.stores;
  if (!Array.isArray(stores)) return { blocked: true, httpStatus: res.status };

  const found = [];
  for (const store of stores) {
    for (const part of country().parts) {
      const a = store.partsAvailability?.[part];
      if (a?.pickupDisplay !== "available") continue;
      const title =
        a.messageTypes?.regular?.storePickupProductTitle ?? a.messageTypes?.compact?.storePickupProductTitle ?? part;
      found.push({
        key: `${store.storeNumber}|${part}`,
        label: title.replace(/^iPhone Duo\s*/, ""),
        store: store.storeName ?? store.storeNumber,
      });
    }
  }
  return { found, stores: stores.map((s) => s.storeName ?? s.storeNumber) };
}

function notifyMac(found) {
  if (process.platform !== "darwin") return;
  const clean = (s) => String(s).replace(/["\\]/g, "");
  const text = found.map((f) => `${clean(f.label)} at ${clean(f.store)}`).join(", ");
  execFile(
    "osascript",
    ["-e", `display notification "${text}" with title "iPhone Duo in stock" sound name "Glass"`],
    () => {},
  );
}

async function tick() {
  const mine = generation;
  let wait = everyMs();
  try {
    if (!cookie) await refreshCookie();
    const result = await askApple();
    if (mine !== generation) return; // country changed mid-flight; a new loop is already running
    if (result.blocked) {
      const mins = BLOCKED_MIN[Math.min(blocksInARow++, BLOCKED_MIN.length - 1)];
      wait = mins * 60_000;
      cookie = "";
      state = { status: "blocked", found: [], stores: [], checkedAt: Date.now(), nextAt: Date.now() + wait, httpStatus: result.httpStatus };
      console.log(`[${new Date().toLocaleTimeString()}] blocked by Apple (HTTP ${result.httpStatus}), next try in ${mins} min`);
    } else {
      blocksInARow = 0;
      const fresh = result.found.filter((f) => !seen.has(f.key));
      seen = new Set(result.found.map((f) => f.key));
      state = {
        status: result.stores.length ? "ok" : "no_stores",
        found: result.found,
        stores: result.stores,
        checkedAt: Date.now(),
        nextAt: Date.now() + wait,
      };
      if (fresh.length) {
        notifyMac(fresh);
        console.log(`[${new Date().toLocaleTimeString()}] IN STOCK: ${fresh.map((f) => `${f.label} at ${f.store}`).join(", ")}`);
      }
    }
  } catch (error) {
    if (mine !== generation) return;
    wait = 60_000;
    state = { status: "error", found: [], stores: [], checkedAt: Date.now(), nextAt: Date.now() + wait, message: String(error?.message ?? error) };
    console.log(`[${new Date().toLocaleTimeString()}] check failed: ${state.message}`);
  }
  timer = setTimeout(tick, wait);
}

function restart() {
  generation++;
  clearTimeout(timer);
  seen = new Set();
  cookie = "";
  const wait = Math.max(0, lastHit + MIN_GAP_MS - Date.now());
  state = { status: "checking", found: [], stores: [], checkedAt: 0, nextAt: Date.now() + wait };
  timer = setTimeout(tick, wait);
}

function publicState() {
  return {
    ...state,
    now: Date.now(),
    country: config.country,
    place: place(),
    buyUrl: buyUrl(),
    countries: Object.entries(COUNTRIES).map(([code, c]) => ({ code, name: c.name, big: Boolean(c.big) })),
  };
}

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  // Only answer requests addressed to this machine, and only same-origin writes.
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") return send(res, 403, { error: "forbidden" });

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, await readFile(join(HERE, "index.html"), "utf8"), "text/html");
  }
  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, publicState());
  if (req.method === "GET" && url.pathname === "/model/duo.usdz") {
    // Optional 3D background, fetched by scripts/get-model.sh. Absent unless you ran that script.
    try {
      const file = await readFile(join(HERE, "model", "duo.usdz"));
      res.writeHead(200, { "content-type": "model/vnd.usdz+zip", "cache-control": "max-age=86400" });
      return res.end(file);
    } catch {
      return send(res, 404, { error: "no model" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/config") {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: "forbidden" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2000) return send(res, 413, { error: "too large" });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    if (!COUNTRIES[body.country]) return send(res, 400, { error: "unknown country" });
    config.country = body.country;
    if (typeof body.place === "string") {
      const p = body.place.trim().slice(0, 40);
      if (p) config.places[config.country] = p;
      else delete config.places[config.country];
    }
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)).catch(() => {});
    restart();
    return send(res, 200, publicState());
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Duo Stock Watch running at http://localhost:${PORT}`);
  console.log(`Watching ${country().name}. Leave this running; close with Ctrl+C.`);
  tick();
});
