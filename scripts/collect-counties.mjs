import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const COUNTY_URL = "https://service.taipower.com.tw/data/opendata/apply/file/d007012/001.csv";

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchBufferOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${url}?github_sync=${Date.now()}`, {
      headers: { "User-Agent": "taiwan-power-observatory-github-action" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`台電來源回傳 HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error("台電來源沒有回傳資料");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

// 同一次執行內最多嘗試 3 次，做法與 collect-power.mjs 的抓取重試一致。
async function fetchBuffer(url) {
  const waits = [3_000, 8_000];
  let lastError;
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    try {
      return await fetchBufferOnce(url);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === waits.length;
      console.warn(`抓取失敗（第 ${attempt + 1} 次）：${url} → ${error?.message || error}`);
      if (isLastAttempt) break;
      await delay(waits[attempt]);
    }
  }
  throw lastError;
}

// 台電這份 CSV 是 Big5 編碼（不是網頁常見的 UTF-8），且有些數字欄位帶千分位逗號、
// 有些沒有，格式本身不一致，需要個別處理，不能直接當純數字解析。
function decodeBig5(buffer) {
  return new TextDecoder("big5").decode(buffer);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function numeric(value) {
  const cleaned = String(value ?? "").replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 圖資（縣市邊界）用的是「台」而不是「臺」，這裡統一轉換，
// 否則「台北市」「臺北市」會被當成兩個不同的縣市，地圖對不上資料。
function normalizeCounty(name) {
  return String(name || "").trim().replace(/臺/g, "台");
}

function rocMonthToIso(yyyymm) {
  const text = String(yyyymm).trim();
  const year = Number(text.slice(0, text.length - 2)) + 1911;
  const month = text.slice(-2);
  return `${year}-${month}`;
}

function buildCountyData(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error("縣市用電資料格式不完整：沒有任何列");
  const header = rows[0].map((cell) => cell.trim());
  const idx = {
    month: header.indexOf("年月"),
    county: header.indexOf("縣市"),
    category: header.indexOf("用電性質"),
    value: header.indexOf("售電量(度)"),
  };
  if (idx.month < 0 || idx.county < 0 || idx.category < 0 || idx.value < 0) {
    throw new Error(`縣市用電資料欄位對不上，實際欄位：${header.join("、")}`);
  }

  const dataRows = rows.slice(1).filter((row) => row.length >= header.length && row[idx.month]);
  if (!dataRows.length) throw new Error("縣市用電資料格式不完整：沒有資料列");

  // 這份 CSV 是完整歷史資料（每個月都會多幾列），不是只有最新一個月，
  // 所以要自己找出最新的年月，只取那一個月的資料。
  const months = [...new Set(dataRows.map((row) => row[idx.month].trim()))].sort();
  const latestMonth = months[months.length - 1];

  const counties = {};
  const categorySet = new Set();
  for (const row of dataRows) {
    if (row[idx.month].trim() !== latestMonth) continue;
    const county = normalizeCounty(row[idx.county]);
    const category = String(row[idx.category]).trim();
    const value = numeric(row[idx.value]);
    if (!county || !category) continue;
    if (!counties[county]) counties[county] = { total: 0, byCategory: {} };
    counties[county].byCategory[category] = value;
    counties[county].total += value;
    categorySet.add(category);
  }

  const countyCount = Object.keys(counties).length;
  if (countyCount < 15) throw new Error(`縣市用電資料格式不完整：只解析到 ${countyCount} 個縣市`);

  return {
    dataMonth: rocMonthToIso(latestMonth),
    categories: [...categorySet].sort(),
    counties,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const buffer = await fetchBuffer(COUNTY_URL);
const csvText = decodeBig5(buffer);
const parsed = buildCountyData(csvText);

await writeJson(resolve(DATA_DIR, "counties.json"), {
  status: "official",
  source: "台灣電力公司政府資料開放平臺－各縣市住宅、服務業及機關用電統計資料",
  schedule: "GitHub Actions 每日檢查，資料本身依台電公告每月更新一次",
  generatedAt: new Date().toISOString(),
  dataMonth: parsed.dataMonth,
  categories: parsed.categories,
  counties: parsed.counties,
});

console.log(`已保存 ${parsed.dataMonth} 縣市用電資料，共 ${Object.keys(parsed.counties).length} 個縣市。`);
