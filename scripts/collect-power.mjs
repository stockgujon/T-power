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

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchJsonOnce(url) {
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

// 同一次執行內最多嘗試 3 次（第 1 次 + 重試 2 次），中間分別等待 3 秒、8 秒，
// 用來吸收台電伺服器偶發的連線逾時；3 次都失敗才真的放棄，不寫入任何猜測值。
async function fetchJson(url) {
  const waits = [3_000, 8_000];
  let lastError;
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    try {
      return await fetchJsonOnce(url);
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

function
