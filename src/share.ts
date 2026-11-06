/**
 * zoom-to-youtube / share.ts（第26版・2026-11-05 開発部・Naoki「zoom録画の共有的に使えるようにしたい。動画共有リンクを自前で作る」）
 *
 * 録画を人に渡すための自前の共有リンク。映像は R2 の原本から流す（YouTube には頼らない）。
 *   ・リンクは推測できない番号（/v/<番号>）。録画ごとに 1 本、R2 に入り終えたら自動で作り、管理シートの T 列に書く
 *   ・U「共有を止める」にチェック → 次の回（5 分以内）から開けない
 *   ・V「共有の期限」に日付 → その日の終わり（日本時間）まで開ける
 *   ・W「開かれた数（自動）」に、再生の画面が開かれた回数を書く
 *   ・S「YouTube に上げる」か Q「学ぶくんに入れる」にチェックがあり、まだ YouTube に無い録画を、上げる候補として返す
 *
 * 置き場（R2）
 *   share/t/<番号>.json   … 1 本のリンクの控え（どの録画か・止めたか・期限・開かれた数）
 *   share/j/<job の置き場>  … 録画からリンクの番号を引く
 * リンクの控えは R2 の置き場（r2Key）を持たない。名前をそろえる段（rename.ts）が置き場を変えるので、
 * 開くたびに録画の控え（job/）から今の置き場を読む。
 *
 * 第27版（2026-11-06 便 1）：短いリンク https://v.shia2n.jp/<7 文字> と、見る画面（player.ts）。
 *   share/s/<7 文字>      … 短い番号からリンクの番号を引く
 *   config/short-host-ok  … v.shia2n.jp に一度でも届いたら置く印。印があるときだけ管理シートに短いリンクを書く
 *                            （住所を Cloudflare の画面で足す前に短いリンクを配って開けない、を防ぐため）
 * 今までの /v/<番号> のリンクはそのまま開く。
 */

import { cuesForPlayer, parseDescription, playerHtml, type PlayerCue } from "./player";
import { mainVideo, recKey, type LegacyRec } from "./legacy";

export interface ShareEnv {
  STORE: R2Bucket;
}

export const SHARE_BASE = "https://zoom-to-youtube.gameister1.workers.dev";
export const SHORT_HOST = "v.shia2n.jp";
export const SHORT_BASE = `https://${SHORT_HOST}`;
const SHORT_OK_KEY = "config/short-host-ok";
const SHORT_LEN = 7;

export interface ShareRec {
  token: string;
  /** 新しい録画：job/ の置き場。古い録画では空 */
  jobKey: string;
  /** 第28版：古い録画（legacy/rec/）の会議の番号。新しい録画では無い */
  legacyId?: string;
  title: string;
  createdAt: string;
  stopped?: boolean;
  /** YYYY-MM-DD。この日の終わり（日本時間）まで開ける */
  expires?: string;
  views: number;
  lastViewedAt?: string;
  /** 第27版：短いリンクの番号（7 文字） */
  short?: string;
}

export interface ShareJob {
  recId: string;
  share?: string;
  title?: string;
  date?: string;
  size?: number;
  rowNo?: number;
  r2Key?: string;
  r2Done?: boolean;
  r2DeletedAt?: string;
  youtubeUrl?: string;
  naming?: { title?: string; description?: string };
}

export interface YoutubeCandidate {
  jobKey: string;
  title: string;
  label: string;
}

export interface ShareSyncResult {
  created: number;
  updated: number;
  candidates: YoutubeCandidate[];
  notes: string[];
  failures: string[];
}

export const tKey = (token: string) => `share/t/${token}.json`;
const sKey = (short: string) => `share/s/${short}`;
/** 第28版：古い録画からリンクの番号を引く */
export const lKey = (uuid: string) => `share/l/${uuid.replace(/[^A-Za-z0-9._-]/g, "_")}`;
export const jKey = (jobKey: string) => `share/j/${jobKey.replace(/[^A-Za-z0-9._-]/g, "_")}`;

export async function readJson<T>(store: R2Bucket, key: string): Promise<T | null> {
  const o = await store.get(key);
  return o ? (JSON.parse(await o.text()) as T) : null;
}

export function newToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 7 文字の短い番号（62^7＝約 3.5 兆通り。数えて当てるのは現実的でない） */
export function newShort(): string {
  const b = new Uint8Array(SHORT_LEN * 2);
  crypto.getRandomValues(b);
  let out = "";
  for (const x of b) {
    if (x >= 248) continue; // 62 の倍数（248）未満だけ使い、偏りを出さない
    out += B62[x % 62];
    if (out.length === SHORT_LEN) break;
  }
  return out.length === SHORT_LEN ? out : newShort();
}

/** リンクの控えに短い番号が無ければ付ける（ぶつかったら引き直す）。付けたら true */
export async function ensureShort(store: R2Bucket, rec: ShareRec): Promise<boolean> {
  if (rec.short) return false;
  for (let i = 0; i < 5; i++) {
    const s = newShort();
    if (await store.head(sKey(s))) continue;
    await store.put(sKey(s), rec.token);
    rec.short = s;
    return true;
  }
  throw new Error("短いリンクの番号がぶつかり続けました");
}

export async function shortHostOk(store: R2Bucket): Promise<boolean> {
  return !!(await store.head(SHORT_OK_KEY));
}

/**
 * 印がまだ無ければ、v.shia2n.jp を自分で 1 回開いてみる（届けば handleShare が印を置く）。
 * 短いリンクを配る前は誰も v.shia2n.jp を開かないので、待っていると切り替わらないため。
 */
async function probeShortHost(store: R2Bucket): Promise<boolean> {
  if (await shortHostOk(store)) return true;
  try {
    await fetch(`${SHORT_BASE}/`, { signal: AbortSignal.timeout(5000) });
  } catch {
    /* まだ住所が無い・届かない。次の回にまた試す */
  }
  return shortHostOk(store);
}

/** 管理シートや画面に出すリンク。v.shia2n.jp が届いていれば短い形、まだなら今までの形 */
export function linkFor(rec: ShareRec, shortOk: boolean): string {
  return shortOk && rec.short ? `${SHORT_BASE}/${rec.short}` : `${SHARE_BASE}/v/${rec.token}`;
}

function checked(v: string | undefined): boolean {
  return (v ?? "").trim().toUpperCase() === "TRUE";
}

/** 「2026-12-01」「2026/12/1」などを YYYY-MM-DD に。読めなければ null、空なら "" */
function readDate(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return "";
  const m = t.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}

/** 共有リンク（台帳 B 列）→ job/ の置き場 */
async function jobIndex(store: R2Bucket): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await store.list({ prefix: "job/", cursor });
    for (const o of page.objects) {
      const j = await readJson<ShareJob>(store, o.key);
      if (j?.share) map.set(j.share.trim(), o.key);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return map;
}

/**
 * 管理シートの行を見て、共有リンクを作る・止める・期限・開かれた数をそろえ、YouTube へ上げる候補を返す。
 * rows は A〜W 列（manageRowsForNames が読む）。
 */
export async function syncShares(
  env: ShareEnv,
  rows: { tab: string; rowNo: number; values: string[] }[],
  shareById: Map<string, string>,
  write: (cells: { range: string; values: string[][] }[]) => Promise<void>,
): Promise<ShareSyncResult> {
  const res: ShareSyncResult = { created: 0, updated: 0, candidates: [], notes: [], failures: [] };
  const idx = await jobIndex(env.STORE);
  const shortOk = await probeShortHost(env.STORE);
  const writes: { range: string; values: string[][] }[] = [];

  for (const r of rows) {
    const v = r.values;
    const id = (v[14] ?? "").trim();
    if (!id) continue;
    const share = shareById.get(id);
    const jobKey = share ? idx.get(share) : undefined;
    if (!jobKey) continue;
    const job = await readJson<ShareJob>(env.STORE, jobKey);
    if (!job || !job.r2Done || !job.r2Key || job.r2DeletedAt) continue;
    const title = (v[4] ?? "").trim() || job.title || "録画";

    // リンクを用意する
    let token = (await (await env.STORE.get(jKey(jobKey)))?.text()) ?? "";
    let rec = token ? await readJson<ShareRec>(env.STORE, tKey(token)) : null;
    let dirty = false;
    let isNew = false;
    if (!rec) {
      token = newToken();
      rec = { token, jobKey, title, createdAt: new Date().toISOString(), views: 0 };
      await env.STORE.put(jKey(jobKey), token);
      dirty = true;
      res.created++;
      isNew = true;
    }
    if (await ensureShort(env.STORE, rec)) dirty = true;
    const link = linkFor(rec, shortOk);
    if (isNew) res.notes.push(`共有リンク：${title}　${link}`);
    if ((v[19] ?? "") !== link) writes.push({ range: `${r.tab}!T${r.rowNo}`, values: [[link]] });

    // 第28版：止める・期限の正本はマーケくんの「録画」（録画の棚）。シートの U・V は写し（2026-11-06 Naoki OK）
    if (rec.title !== title) {
      rec.title = title;
      dirty = true;
      res.updated++;
    }
    if (dirty) await env.STORE.put(tKey(token), JSON.stringify(rec));
    const stopCopy = rec.stopped ? "TRUE" : "FALSE";
    if ((v[20] ?? "").trim().toUpperCase() !== stopCopy) writes.push({ range: `${r.tab}!U${r.rowNo}`, values: [[stopCopy]] });
    if ((readDate(v[21]) ?? "") !== (rec.expires ?? "")) writes.push({ range: `${r.tab}!V${r.rowNo}`, values: [[rec.expires ?? ""]] });

    const views = String(rec.views ?? 0);
    if ((v[22] ?? "") !== views) writes.push({ range: `${r.tab}!W${r.rowNo}`, values: [[views]] });

    // YouTube へ上げる候補
    if ((checked(v[18]) || checked(v[16])) && !job.youtubeUrl) {
      res.candidates.push({ jobKey, title, label: `${r.tab} の ${r.rowNo} 行目` });
    }
  }

  // 見出し（S〜W）。無いタブだけでなく毎回そろえても害は無い
  const tabs = [...new Set(rows.map((r) => r.tab))];
  for (const tab of tabs) {
    writes.push({
      range: `${tab}!S1:W1`,
      values: [["YouTube に上げる", "共有リンク（自動）", "共有を止める（写し・マーケくんの録画で変える）", "共有の期限（写し・マーケくんの録画で変える）", "開かれた数（自動）"]],
    });
  }
  await write(writes);
  return res;
}

/* ------------------------------------------------------------------ */
/* 見る側                                                              */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const NO_INDEX = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title>
<style>
:root{--bg:#f5f0eb;--panel:#fff;--line:#e6dfd6;--fg:#1a1a1a;--muted:#6b6259}
@media (prefers-color-scheme:dark){:root{--bg:#1b1916;--panel:#24211d;--line:#38332c;--fg:#f1ece6;--muted:#b0a69b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 "Noto Sans JP",system-ui,-apple-system,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;font-weight:800;margin:0 0 4px;line-height:1.4}
.meta{color:var(--muted);font-size:13px;margin:0 0 16px}
.box{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
video{display:block;width:100%;max-height:78vh;background:#000}
.msg{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:32px 24px;text-align:center}
.msg p{margin:0;color:var(--muted)}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_INDEX } });
}

function closed(why: string, status: number): Response {
  return page("見られません", `<div class="msg"><h1>この録画は見られません</h1><p>${esc(why)}</p></div>`, status);
}

interface Media {
  videoKey: string;
  vttKey: string | null;
  date?: string;
  description?: string;
}

/** リンクの控えから、今の映像と文字起こしの置き場を読む（名前をそろえる段が置き場を変えるので毎回読む） */
export async function mediaFor(env: ShareEnv, rec: ShareRec): Promise<Media | null> {
  if (rec.legacyId) {
    const r = await readJson<LegacyRec>(env.STORE, recKey(rec.legacyId));
    if (!r || r.r2DeletedAt || !r.r2Done) return null;
    const v = mainVideo(r.files);
    if (!v?.r2Key) return null;
    const t = r.files.find((f) => f.type === "TRANSCRIPT" && f.r2Done && f.r2Key);
    return { videoKey: v.r2Key, vttKey: t?.r2Key ?? null, date: r.date, description: r.naming?.description };
  }
  const job = await readJson<ShareJob>(env.STORE, rec.jobKey);
  if (!job || !job.r2Key || job.r2DeletedAt) return null;
  return { videoKey: job.r2Key, vttKey: job.r2Key.replace(/\.mp4$/i, ".vtt"), date: job.date, description: job.naming?.description };
}

/** 開けるかを確かめ、開けるなら控えと今の置き場を返す */
async function open(env: ShareEnv, token: string): Promise<{ rec: ShareRec; media: Media } | { why: string; status: number }> {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return { why: "リンクが正しくありません。", status: 404 };
  const rec = await readJson<ShareRec>(env.STORE, tKey(token));
  if (!rec) return { why: "リンクが正しくありません。", status: 404 };
  if (rec.stopped) return { why: "共有が止められています。", status: 410 };
  if (rec.expires && todayJst() > rec.expires) return { why: "共有の期限が過ぎました。", status: 410 };
  const media = await mediaFor(env, rec);
  if (!media) return { why: "録画が見つかりません。", status: 404 };
  return { rec, media };
}

/** 文字起こし（映像の隣の .vtt）を見る画面の形で。無ければ空 */
async function playerCues(env: ShareEnv, vttKey: string | null): Promise<PlayerCue[]> {
  if (!vttKey) return [];
  const o = await env.STORE.get(vttKey);
  if (!o) return [];
  try {
    return await cuesForPlayer(await o.text());
  } catch {
    return [];
  }
}

/**
 * 見る画面と映像を返す。それ以外は null（呼ぶ側が 404 を返す）。
 *   どの住所でも：/v/<番号>・/v/<番号>/video
 *   v.shia2n.jp：/<7 文字>・/<7 文字>/video
 */
export async function handleShare(request: Request, env: ShareEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const onShort = url.hostname === SHORT_HOST;
  if (onShort && !(await shortHostOk(env.STORE))) {
    await env.STORE.put(SHORT_OK_KEY, JSON.stringify({ at: new Date().toISOString() }));
  }
  let token = "";
  let base = "";
  let video = false;
  const long = url.pathname.match(/^\/v\/([^/]+)(\/video)?$/);
  const short = onShort ? url.pathname.match(/^\/([A-Za-z0-9]{7})(\/video)?$/) : null;
  if (long) {
    token = long[1];
    base = `/v/${long[1]}`;
    video = !!long[2];
  } else if (short) {
    token = (await (await env.STORE.get(sKey(short[1])))?.text()) ?? "";
    base = `/${short[1]}`;
    video = !!short[2];
    if (!token) return video ? new Response("リンクが正しくありません。", { status: 404, headers: NO_INDEX }) : closed("リンクが正しくありません。", 404);
  } else {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("", { status: 405 });
  const got = await open(env, token);
  if ("why" in got) return video ? new Response(got.why, { status: got.status, headers: NO_INDEX }) : closed(got.why, got.status);
  const { rec, media } = got;

  if (!video) {
    rec.views = (rec.views ?? 0) + 1;
    rec.lastViewedAt = new Date().toISOString();
    await env.STORE.put(tKey(rec.token), JSON.stringify(rec));
    const { summary, chapters } = parseDescription(media.description);
    const html = playerHtml({
      title: rec.title,
      date: media.date,
      videoSrc: `${base}/video`,
      shareUrl: onShort ? `${SHORT_BASE}${base}` : `${SHARE_BASE}/v/${rec.token}`,
      key: rec.short ?? rec.token.slice(0, 12),
      summary,
      chapters,
      cues: await playerCues(env, media.vttKey),
    });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...NO_INDEX } });
  }
  return streamVideo(request, env, media.videoKey);
}

/** R2 の原本を Range つきで流す（Safari は 0-1 の Range を送ってくるので 206 を正しく返す） */
async function streamVideo(request: Request, env: ShareEnv, key: string): Promise<Response> {
  const head = await env.STORE.head(key);
  if (!head) return new Response("録画が見つかりません。", { status: 404, headers: NO_INDEX });
  const size = head.size;
  const base: Record<string, string> = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "content-disposition": "inline",
    ...NO_INDEX,
    "cache-control": "private, max-age=3600",
  };

  const range = request.headers.get("range");
  let start = 0;
  let end = size - 1;
  let partial = false;
  if (range) {
    const r = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!r || (r[1] === "" && r[2] === "")) {
      return new Response("", { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
    }
    if (r[1] === "") {
      const n = Number(r[2]);
      start = Math.max(0, size - n);
    } else {
      start = Number(r[1]);
      if (r[2] !== "") end = Math.min(Number(r[2]), size - 1);
    }
    if (start >= size || start > end) {
      return new Response("", { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
    }
    partial = true;
  }
  const length = end - start + 1;
  const headers: Record<string, string> = { ...base, "content-length": String(length) };
  if (partial) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  if (request.method === "HEAD") return new Response(null, { status: partial ? 206 : 200, headers });
  const o = await env.STORE.get(key, { range: { offset: start, length } });
  if (!o) return new Response("録画が見つかりません。", { status: 404, headers: NO_INDEX });
  return new Response(o.body, { status: partial ? 206 : 200, headers });
}

/** 上げる段のために、job/ の控えを読む・書く */
export async function readShareJob(env: ShareEnv, jobKey: string): Promise<ShareJob | null> {
  return readJson<ShareJob>(env.STORE, jobKey);
}
