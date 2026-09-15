import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const SUPPLY_URL = "https://service.taipower.com.tw/data/opendata/apply/file/d006020/001.json";
const GENERATION_URL = "https://service.taipower.com.tw/data/opendata/apply/file/d006001/001.json";
const RETAIN_DAYS = 35;

function numeric(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTaipeiDate(value) {
  const text = String(value || "").trim().replace(/\//g, "-");
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(" ", "T")}+08:00`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`無法辨識台電資料時間：${value}`);
  return date;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${url}?github_sync=${Date.now()}`, {
      headers: { Accept: "application/json", "User-Agent": "taiwan-power-observatory-github-action" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`台電來源回傳 HTTP ${response.status}`);
    const text = (await response.text()).replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error("台電來源沒有回傳資料");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function buildSnapshot(supplyData, generationData) {
  const supplyRows = Array.isArray(supplyData?.records) ? supplyData.records : [];
  const supply = supplyRows[0] || {};
  const forecast = supplyRows[1] || supply;
  const unitRows = Array.isArray(generationData?.aaData) ? generationData.aaData : [];
  const totals = new Map();

  for (const row of unitRows) {
    const type = String(row?.["機組類型"] ?? "").trim();
    const name = String(row?.["機組名稱"] ?? "").trim();
    if (!name.startsWith("小計")) continue;
    totals.set(type, numeric(row?.["淨發電量(MW)"]));
  }

  const gas = numeric(totals.get("燃氣")) + numeric(totals.get("民營電廠-燃氣"));
  const coal = numeric(totals.get("燃煤")) + numeric(totals.get("民營電廠-燃煤"));
  const solar = numeric(totals.get("太陽能"));
  const wind = numeric(totals.get("風力"));
  const hydro = numeric(totals.get("水力"));
  const generation = Array.from(totals.values()).reduce((sum, value) => sum + Math.max(0, numeric(value)), 0);
  const other = Math.max(0, generation - gas - coal - solar - wind - hydro);
  const observed = parseTaipeiDate(generationData?.DateTime);
  const load = numeric(supply.curr_load) * 10;
  const capacity = numeric(supply.real_hr_maxi_sply_capacity || forecast.fore_maxi_sply_capacity) * 10;

  if (!load || !generation || unitRows.length < 2) throw new Error("台電資料格式不完整");

  return {
    observedAt: observed.toISOString(),
    sourceUpdatedAt: String(generationData?.DateTime || supply.publish_time || ""),
    collectedAt: new Date().toISOString(),
    loadMw: Math.round(load),
    generationMw: Math.round(generation),
    gasMw: Math.round(gas),
    coalMw: Math.round(coal),
    solarMw: Math.round(solar),
    windMw: Math.round(wind),
    hydroMw: Math.round(hydro),
    otherMw: Math.round(other),
    capacityMw: Math.round(capacity),
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function taipeiMonth(date) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("無法產生台北時區月份");
  return `${year}-${month}`;
}

function mergeSnapshots(existing, next) {
  const byTime = new Map(existing.map((row) => [row.observedAt, row]));
  byTime.set(next.observedAt, next);
  return Array.from(byTime.values()).sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
}

const [supplyData, generationData] = await Promise.all([fetchJson(SUPPLY_URL), fetchJson(GENERATION_URL)]);
const snapshot = buildSnapshot(supplyData, generationData);
const month = taipeiMonth(new Date(snapshot.observedAt));
const archivePath = resolve(DATA_DIR, "archive", `${month}.json`);
const archive = await readJson(archivePath, { month, snapshots: [] });
archive.generatedAt = new Date().toISOString();
archive.snapshots = mergeSnapshots(archive.snapshots || [], snapshot);
await writeJson(archivePath, archive);

const recentPath = resolve(DATA_DIR, "recent.json");
const recent = await readJson(recentPath, { snapshots: [] });
const cutoff = Date.now() - RETAIN_DAYS * 86_400_000;
const snapshots = mergeSnapshots(recent.snapshots || [], snapshot)
  .filter((row) => new Date(row.observedAt).getTime() >= cutoff);

await writeJson(recentPath, {
  status: "official",
  source: "台灣電力公司政府資料開放平臺",
  schedule: "GitHub Actions 每小時自動存檔",
  generatedAt: new Date().toISOString(),
  latest: snapshot,
  snapshots,
});

await writeJson(resolve(DATA_DIR, "latest.json"), {
  status: "official",
  source: "台灣電力公司政府資料開放平臺",
  schedule: "GitHub Actions 每小時自動存檔",
  generatedAt: new Date().toISOString(),
  latest: snapshot,
});

console.log(`已保存 ${snapshot.sourceUpdatedAt} 台電資料；最近資料共 ${snapshots.length} 筆。`);
