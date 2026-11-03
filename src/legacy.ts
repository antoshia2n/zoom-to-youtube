/**
 * zoom-to-youtube / legacy.ts（第19版・2026-11-02 開発部・経理系の依頼 1 便 2）
 *
 * 2026-11-02 より前に録った、Zoom のクラウドに今ある録画（約 88GB）を R2 へ移す。
 * 新しい録画（便 1）は台帳の行から流れるが、こちらは Zoom の一覧から直接、会議 1 回ずつ運ぶ。
 *
 * 決め（作る前の 1 枚・Naoki OK 2026-11-02）
 *   ・原本の保管が目的。会議 1 回ぶんのファイルは全部 R2 へ入れる（動画が複数でも、音声・チャット・文字起こしも）
 *   ・YouTube に上げ済みのものは上げ直さない。その題名を R2 のファイル名に使う
 *   ・YouTube と結び付かなかったものは、この便では上げない（一覧に「YouTube 無し」で出す。本数を見てから決める）
 *   ・Zoom からは消さない（便 3）
 *
 * YouTube との結び付け方（上から順に試す）
 *   1. 第18版より前に台帳から上げた録画：控え（job/）の動画の大きさが、Zoom の動画ファイルの大きさとぴったり同じもの
 *   2. それより前に手で上げた録画：YouTube の動画の長さが Zoom の動画の長さと 90 秒（または 2%）以内で、
 *      録画の日から 45 日以内に上がった動画が、ちょうど 1 本だけあるもの
 *   どちらでも決まらなければ「結び付かない」にして、理由を残す（候補 0 本／2 本以上）
 */
import {
  AUTO_FROM,
  decideR2Key,
  fileSafe,
  listZoomRecordings,
  nameRecording,
  sendToR2,
  zoomToken,
  type ArchiveEnv,
  type Naming,
  type ZoomMeeting,
  type ZoomRecFile,
} from "./archive";

const INDEX_KEY = "legacy/index.json";
const REC_PREFIX = "legacy/rec/";
const YT_CACHE_KEY = "legacy/youtube.json";
const DAY = 86400000;
/** 一覧を遡るいちばん古い月 */
const FLOOR = "2020-01";
/** 続けてこれだけ空の月が並んだら、それより前は無いとみなす */
const EMPTY_STREAK = 12;
/** 1 回の実行で運ぶ上限（呼び出しの数と時間を抑えるため） */
const BYTES_PER_RUN = 2 * 1024 * 1024 * 1024;
/** R2 へ入れる 1 個の大きさ（新しい録画の 8MB より大きくして、呼び出しの数を減らす） */
const LEGACY_CHUNK = 32 * 1024 * 1024;

export interface LegacyFile {
  id: string;
  type: string;
  ext: string;
  recType: string;
  size: number;
  start: string;
  url: string;
  r2Key?: string;
  r2UploadId?: string;
  r2Parts?: { partNumber: number; etag: string }[];
  r2Done?: boolean;
  /** 第21版：途中から読む頼みでメモリの上限に当たったファイルは、次から流しながら入れる */
  forceStream?: boolean;
  /** 第24版：文字のファイルで、Zoom の一覧の大きさが届いた中身と違ったときの一覧の値（size は届いた方に直す） */
  listSize?: number;
}

/** 動画・音声ではないファイル（チャット・字幕・文字起こしなど）。大きさの食い違いを許すのはこれだけ */
function textLike(f: LegacyFile): boolean {
  return f.type !== "MP4" && f.type !== "M4A";
}

export interface LegacyRec {
  uuid: string;
  date: string;
  start: string;
  durationSec: number;
  totalSize: number;
  files: LegacyFile[];
  match?: { kind: "job" | "youtube" | "none"; youtubeUrl?: string; title?: string; jobRecId?: string; note?: string };
  naming?: Naming;
  /** 全部のファイルが R2 に入ったか */
  r2Done?: boolean;
  /** 便 3 で入る */
  zoomDeletedAt?: string;
  /** 第21版：探す・消す道具で R2 から消した（要らないと決めた）日時。R2 へは入れ直さない */
  r2DeletedAt?: string;
  lastError?: string;
  updatedAt: string;
}

export function recKey(uuid: string): string {
  return REC_PREFIX + uuid.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
}

async function loadJson<T>(env: ArchiveEnv, key: string): Promise<T | null> {
  const o = await env.STORE.get(key);
  return o ? (JSON.parse(await o.text()) as T) : null;
}

async function saveRec(env: ArchiveEnv, r: LegacyRec): Promise<void> {
  r.updatedAt = new Date().toISOString();
  await env.STORE.put(recKey(r.uuid), JSON.stringify(r));
}

function jstDate(ms: number): string {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const VIDEO_ORDER = [
  "shared_screen_with_speaker_view",
  "shared_screen_with_speaker_view(CC)",
  "shared_screen_with_gallery_view",
  "shared_screen",
  "speaker_view",
  "active_speaker",
  "gallery_view",
];

/** 会議の中の「主の動画」（いちばん早い区切りの、画面つきの動画） */
export function mainVideo(files: LegacyFile[]): LegacyFile | null {
  const videos = files.filter((f) => f.type === "MP4");
  if (!videos.length) return null;
  const firstStart = videos.map((f) => f.start).sort()[0];
  const first = videos.filter((f) => f.start === firstStart);
  first.sort((a, b) => rank(a.recType) - rank(b.recType) || b.size - a.size);
  return first[0];
}
function rank(t: string): number {
  const i = VIDEO_ORDER.indexOf(t);
  return i < 0 ? 99 : i;
}

function toFiles(m: ZoomMeeting): LegacyFile[] {
  return (m.recording_files ?? [])
    .filter((f: ZoomRecFile) => f.id && f.download_url && (f.status ?? "completed").toLowerCase() === "completed")
    .map((f) => ({
      id: f.id as string,
      type: (f.file_type ?? "").toUpperCase(),
      ext: (f.file_extension ?? f.file_type ?? "bin").toLowerCase(),
      recType: f.recording_type ?? "",
      size: f.file_size ?? 0,
      start: f.recording_start ?? "",
      url: f.download_url as string,
    }));
}

function durOf(f: LegacyFile | null, m: ZoomMeeting): number {
  if (f) {
    const z = (m.recording_files ?? []).find((x) => x.id === f.id);
    const a = Date.parse(z?.recording_start ?? "");
    const b = Date.parse(z?.recording_end ?? "");
    if (a && b && b > a) return Math.round((b - a) / 1000);
  }
  return (m.duration ?? 0) * 60;
}

/* ------------------------------------------------------------------ */
/* 1. 移す対象の一覧を作る（1 日 1 回作り直す）                        */
/* ------------------------------------------------------------------ */

interface LegacyIndex {
  builtAt: string;
  uuids: string[];
  oldestMonth: string;
}

async function buildIndex(env: ArchiveEnv, out: (s: string) => void): Promise<LegacyIndex> {
  const cached = await loadJson<LegacyIndex>(env, INDEX_KEY);
  if (cached && Date.now() - Date.parse(cached.builtAt) < DAY) return cached;

  const autoFrom = Date.parse(AUTO_FROM);
  const found: { uuid: string; start: string }[] = [];
  let y = 2026;
  let mo = 11; // 11 月から遡る
  let empty = 0;
  let oldest = "";
  for (let guard = 0; guard < 120; guard++) {
    const ym = `${y}-${String(mo).padStart(2, "0")}`;
    if (ym < FLOOR) break;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const meetings = await listZoomRecordings(env, `${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`);
    let n = 0;
    for (const m of meetings) {
      if (!m.uuid || !m.start_time || Date.parse(m.start_time) >= autoFrom) continue;
      const files = toFiles(m);
      if (!files.length) continue;
      n++;
      found.push({ uuid: m.uuid, start: m.start_time });
      const prev = await loadJson<LegacyRec>(env, recKey(m.uuid));
      if (!prev) {
        const main = mainVideo(files);
        const rec: LegacyRec = {
          uuid: m.uuid,
          date: jstDate(Date.parse(m.start_time)),
          start: m.start_time,
          durationSec: durOf(main, m),
          totalSize: files.reduce((a, f) => a + f.size, 0),
          files,
          updatedAt: "",
        };
        await saveRec(env, rec);
      } else if (!prev.r2Done) {
        // ダウンロードの住所は変わることがあるので、まだ運び終えていない会議は取り直した住所に差し替える
        const byId = new Map(files.map((f) => [f.id, f]));
        for (const f of prev.files) {
          const nf = byId.get(f.id);
          if (nf) f.url = nf.url;
        }
        await saveRec(env, prev);
      }
    }
    if (n > 0) {
      empty = 0;
      oldest = ym;
    } else if (++empty >= EMPTY_STREAK) break;
    mo--;
    if (mo === 0) {
      mo = 12;
      y--;
    }
  }
  found.sort((a, b) => (a.start < b.start ? -1 : 1));
  const idx: LegacyIndex = { builtAt: new Date().toISOString(), uuids: [...new Set(found.map((f) => f.uuid))], oldestMonth: oldest };
  await env.STORE.put(INDEX_KEY, JSON.stringify(idx));
  out(`  移す対象の一覧を作り直した（${idx.uuids.length} 回分・いちばん古い月 ${oldest || "なし"}）`);
  return idx;
}

/* ------------------------------------------------------------------ */
/* 2. YouTube と結び付ける                                             */
/* ------------------------------------------------------------------ */

interface YtVideo {
  id: string;
  title: string;
  publishedAt: string;
  durationSec: number;
}

function isoDur(s: string): number {
  const m = s.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

async function ytVideos(env: ArchiveEnv, ytToken: () => Promise<string>): Promise<YtVideo[]> {
  const cached = await loadJson<{ at: string; videos: YtVideo[] }>(env, YT_CACHE_KEY);
  if (cached && Date.now() - Date.parse(cached.at) < DAY) return cached.videos;
  const token = await ytToken();
  const get = async (url: string) => {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`YouTube の一覧を読めません（${r.status}）`);
    return r.json();
  };
  const ch = (await get("https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true")) as {
    items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
  };
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("YouTube のチャンネルの入れ物が見つかりません");
  const ids: string[] = [];
  let page = "";
  for (let g = 0; g < 100; g++) {
    const p = (await get(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}` +
        (page ? `&pageToken=${page}` : ""),
    )) as { items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string };
    for (const it of p.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    if (!p.nextPageToken) break;
    page = p.nextPageToken;
  }
  const videos: YtVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = (await get(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${ids.slice(i, i + 50).join(",")}`,
    )) as { items?: { id?: string; snippet?: { title?: string; publishedAt?: string }; contentDetails?: { duration?: string } }[] };
    for (const it of v.items ?? []) {
      videos.push({
        id: it.id ?? "",
        title: it.snippet?.title ?? "",
        publishedAt: it.snippet?.publishedAt ?? "",
        durationSec: isoDur(it.contentDetails?.duration ?? ""),
      });
    }
  }
  await env.STORE.put(YT_CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), videos }));
  return videos;
}

interface JobLite {
  recId: string;
  size: number;
  title?: string;
  youtubeUrl?: string;
}

async function jobsBySize(env: ArchiveEnv): Promise<Map<number, JobLite[]>> {
  const map = new Map<number, JobLite[]>();
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await env.STORE.list({ prefix: "job/", cursor });
    for (const o of page.objects) {
      const j = await loadJson<JobLite>(env, o.key);
      if (!j?.youtubeUrl || !j.size) continue;
      map.set(j.size, [...(map.get(j.size) ?? []), j]);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return map;
}

/** 結び付け。claimed は、すでに別の会議に結び付けた YouTube の番号 */
export function matchRecording(
  rec: LegacyRec,
  jobs: Map<number, JobLite[]>,
  videos: YtVideo[],
  claimed: Set<string>,
): NonNullable<LegacyRec["match"]> {
  for (const f of rec.files.filter((x) => x.type === "MP4")) {
    const hit = jobs.get(f.size);
    if (hit?.length === 1) return { kind: "job", youtubeUrl: hit[0].youtubeUrl, title: hit[0].title, jobRecId: hit[0].recId };
  }
  const start = Date.parse(rec.start);
  const tol = Math.max(90, rec.durationSec * 0.02);
  const cands = videos.filter((v) => {
    if (claimed.has(v.id) || !v.durationSec || !rec.durationSec) return false;
    const pub = Date.parse(v.publishedAt);
    return Math.abs(v.durationSec - rec.durationSec) <= tol && pub >= start - DAY && pub <= start + 45 * DAY;
  });
  if (cands.length === 1) {
    return { kind: "youtube", youtubeUrl: `https://www.youtube.com/watch?v=${cands[0].id}`, title: cands[0].title };
  }
  return { kind: "none", note: cands.length === 0 ? "YouTube に長さの合う動画が無い" : `長さの合う動画が ${cands.length} 本あって決められない` };
}

/* ------------------------------------------------------------------ */
/* 3. 運ぶ                                                             */
/* ------------------------------------------------------------------ */

/** Zoom のダウンロードの住所から範囲を読む。住所は署名つきの別の住所へ飛ばされるので、飛び先を取ってから読む */
async function readZoomRange(token: string, url: string, start: number, end: number): Promise<ArrayBuffer> {
  const first = await fetch(url, { headers: { authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` }, redirect: "manual" });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get("location");
    await first.body?.cancel();
    if (!loc) throw new Error("Zoom のダウンロードの飛び先がありません");
    res = await fetch(new URL(loc, url).toString(), { headers: { Range: `bytes=${start}-${end}` } });
  }
  if (res.status !== 206 && res.status !== 200) {
    const why = (await res.text()).slice(0, 200);
    throw new Error(`Zoom がファイルの一部を返しません（${res.status}／${why}）`);
  }
  return res.arrayBuffer();
}

/** 先頭 1 バイトを頼み、途中から読めるか（206）と本当の大きさを聞く */
async function probeZoom(token: string, url: string): Promise<{ size: number | null; ranged: boolean }> {
  const first = await fetch(url, { headers: { authorization: `Bearer ${token}`, Range: "bytes=0-0" }, redirect: "manual" });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get("location");
    await first.body?.cancel();
    if (!loc) return { size: null, ranged: false };
    res = await fetch(new URL(loc, url).toString(), { headers: { Range: "bytes=0-0" } });
  }
  const cr = res.headers.get("content-range");
  const len = res.headers.get("content-length");
  await res.body?.cancel();
  if (res.status === 416) return { size: 0, ranged: true };
  if (res.status === 206 && cr && /\/\d+$/.test(cr)) return { size: Number(cr.split("/")[1]), ranged: true };
  if (res.status === 200) return { size: len ? Number(len) : null, ranged: false };
  return { size: null, ranged: false };
}

/**
 * 第20版の 2 回目の直し：途中から読む頼みを聞かず丸ごと返してくるファイルは、流れてくるそばから 16MB ずつ R2 へ入れる。
 * 途中で止めると続きからは入れられないので、時間が足りなければ分割アップロードを捨てて次の実行で最初からやり直す。
 */
async function streamZoomToR2(
  env: ArchiveEnv,
  token: string,
  f: LegacyFile,
  deadline: number,
  out: (s: string) => void,
  beat: () => Promise<void>,
): Promise<boolean> {
  const PART = 16 * 1024 * 1024;
  const first = await fetch(f.url, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get("location");
    await first.body?.cancel();
    if (!loc) throw new Error("Zoom のダウンロードの飛び先がありません");
    res = await fetch(new URL(loc, f.url).toString());
  }
  if (!res.ok || !res.body) throw new Error(`Zoom がファイルを返しません（${f.type}・${res.status}）`);
  // 第24版：返りの content-length（圧縮されていないときだけ）を控え、読み切った大きさと突き合わせる
  const cl = res.headers.get("content-encoding") ? null : res.headers.get("content-length");
  const served = cl && /^\d+$/.test(cl) ? Number(cl) : null;
  const key = f.r2Key as string;
  const upload = await env.STORE.createMultipartUpload(key, { httpMetadata: { contentType: f.type === "MP4" ? "video/mp4" : "application/octet-stream" } });
  const parts: R2UploadedPart[] = [];
  const reader = res.body.getReader();
  let buf = new Uint8Array(PART);
  let fill = 0;
  let total = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        await reader.cancel();
        await upload.abort();
        out(`      時間が足りないので、このファイル（${(f.size / 1048576).toFixed(0)} MB）は次の実行で最初から入れ直します`);
        return false;
      }
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.byteLength) {
        const n = Math.min(PART - fill, value.byteLength - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === PART) {
          parts.push(await upload.uploadPart(parts.length + 1, buf));
          total += fill;
          buf = new Uint8Array(PART);
          fill = 0;
          await beat();
        }
      }
    }
    if (fill > 0 || parts.length === 0) {
      parts.push(await upload.uploadPart(parts.length + 1, buf.subarray(0, fill)));
      total += fill;
    }
    await upload.complete(parts);
  } catch (e) {
    try {
      await upload.abort();
    } catch {
      /* 捨てられなくても次の実行で作り直す */
    }
    throw e;
  }
  const head = await env.STORE.head(key);
  if (head && f.size > 0 && head.size !== f.size && textLike(f) && head.size === total && (served === null || served === total)) {
    // 第24版（2026-11-03）：チャット・字幕などの文字のファイルは、Zoom の一覧の大きさと実際に返す中身の大きさが違う
    // （11/03 朝に 140 回分、どれも一覧より 3〜5% 小さく、入れ直しても同じ大きさ）。流れが最後まで届き、
    // 返りの content-length とも合っていれば、届いた中身を正として控えの大きさを直す。動画と音声は今までどおり厳しく見る
    out(`      ${f.type}：Zoom の一覧は ${f.size} バイト、届いた中身は ${head.size} バイト。届いた方を正とします`);
    f.listSize = f.size;
    f.size = head.size;
  }
  if (!head || (f.size > 0 && head.size !== f.size)) {
    throw new Error(`R2 の大きさが Zoom と合いません（${f.type}・R2 ${head?.size ?? "無し"}・Zoom ${f.size}・読んだ ${total}・返りの長さ ${served ?? "無し"}）`);
  }
  if (f.size <= 0) f.size = head.size;
  f.r2Done = true;
  f.r2UploadId = undefined;
  f.r2Parts = undefined;
  return true;
}

/** 先頭 1 バイトを頼み、返りの content-range から本当の大きさを取る。分からなければ null */
async function probeZoomSize(token: string, url: string): Promise<number | null> {
  const first = await fetch(url, { headers: { authorization: `Bearer ${token}`, Range: "bytes=0-0" }, redirect: "manual" });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get("location");
    await first.body?.cancel();
    if (!loc) return null;
    res = await fetch(new URL(loc, url).toString(), { headers: { Range: "bytes=0-0" } });
  }
  const cr = res.headers.get("content-range");
  const len = res.headers.get("content-length");
  await res.body?.cancel();
  if (res.status === 416) return 0;
  if (cr && /\/\d+$/.test(cr)) return Number(cr.split("/")[1]);
  if (res.status === 200 && len) return Number(len);
  return null;
}

async function readZoomText(token: string, url: string): Promise<string | null> {
  const first = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
  let r = first;
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get("location");
    await first.body?.cancel();
    if (!loc) return null;
    // 飛び先は署名つきの住所なので、鍵は付けない（付けると断られることがある）
    r = await fetch(new URL(loc, url).toString());
  }
  if (!r.ok) {
    await r.body?.cancel();
    return null;
  }
  return r.text();
}

export interface LegacyStepResult {
  total: number;
  done: number;
  movedBytes: number;
  remainingBytes: number;
  matched: { job: number; youtube: number; none: number };
  errors: string[];
  error?: string;
}

/**
 * 1 回の実行の残り時間で、古い録画を運ぶ。古い順に 1 会議ずつ：結び付け → 名前 → ファイルを全部 R2 へ。
 * 1 回で運ぶのは BYTES_PER_RUN まで。止まった所は控えに残り、次の実行が続ける。
 */
export async function migrateLegacy(
  env: ArchiveEnv,
  deadline: number,
  ytToken: () => Promise<string>,
  out: (s: string) => void,
  beat: () => Promise<void>,
): Promise<LegacyStepResult> {
  const res: LegacyStepResult = { total: 0, done: 0, movedBytes: 0, remainingBytes: 0, matched: { job: 0, youtube: 0, none: 0 }, errors: [] };
  try {
    const idx = await buildIndex(env, out);
    res.total = idx.uuids.length;
    let jobs: Map<number, JobLite[]> | null = null;
    let videos: YtVideo[] | null = null;
    let zoom: string | null = null;
    const recs: LegacyRec[] = [];
    for (const u of idx.uuids) {
      const r = await loadJson<LegacyRec>(env, recKey(u));
      if (r) recs.push(r);
    }
    const claimed = new Set(recs.map((r) => (r.match?.kind === "youtube" ? r.match.youtubeUrl?.split("v=")[1] ?? "" : "")).filter(Boolean));
    const stop = () => Date.now() > deadline || res.movedBytes >= BYTES_PER_RUN;

    for (const rec of recs) {
      if (rec.r2Done || rec.r2DeletedAt) continue;
      if (stop()) break;
      try {
        out(`【古い録画】${rec.date}（${(rec.totalSize / 1073741824).toFixed(2)} GB・ファイル ${rec.files.length} 個）`);
        zoom ??= await zoomToken(env);
        if (!rec.match) {
          jobs ??= await jobsBySize(env);
          videos ??= await ytVideos(env, ytToken);
          rec.match = matchRecording(rec, jobs, videos, claimed);
          if (rec.match.kind === "youtube") claimed.add(rec.match.youtubeUrl?.split("v=")[1] ?? "");
          await saveRec(env, rec);
          out(`  YouTube：${rec.match.kind === "none" ? "結び付かない（" + rec.match.note + "）" : rec.match.kind === "job" ? "台帳の控えで結び付いた" : "長さで結び付いた"}`);
        }
        if (!rec.naming) {
          const tr = rec.files.find((f) => f.type === "TRANSCRIPT");
          const vtt = tr ? await readZoomText(zoom, tr.url) : null;
          const human = rec.match.title ?? "";
          const n = await nameRecording(env, vtt, rec.date, rec.durationSec, human);
          // YouTube の題名があるときは、ファイル名の話題もその題名から取る（作る前の 1 枚）
          rec.naming = human ? { ...n, topic: fileSafe(human), note: [n.note, "YouTube の題名を使った"].filter(Boolean).join("・") } : n;
          await saveRec(env, rec);
          out(`  名前：会 ${rec.naming.kai}／${rec.naming.mode}`);
        }
        const main = mainVideo(rec.files);
        if (!rec.files.some((f) => f.r2Key)) {
          const mainKey = await decideR2Key(env, rec.date, rec.naming.kai, rec.naming.topic);
          const base = mainKey.replace(/\.mp4$/, "");
          let n = 1;
          for (const f of rec.files) {
            if (main && f.id === main.id) f.r2Key = mainKey;
            else if (f.type === "TRANSCRIPT") f.r2Key = `${base}.vtt`;
            else f.r2Key = `${base}_${++n}_${fileSafe(f.recType || f.type, 40)}.${f.ext}`;
          }
          await saveRec(env, rec);
        }
        for (const f of rec.files) {
          if (f.r2Done) continue;
          if (stop()) break;
          if (f.size <= 0) {
            // 第20版：一覧に大きさが出ていないファイルは、まず先頭 1 バイトを頼んで本当の大きさを聞く。
            // （第19版は丸ごと読もうとして、大きな動画でメモリの上限に当たった・2026-11-02 の 2022-07-31）
            const real = await probeZoomSize(zoom, f.url);
            if (real === null) throw new Error(`${f.type} のファイルの大きさが分かりません`);
            if (real === 0) {
              await env.STORE.put(f.r2Key as string, "");
              f.r2Done = true;
              await saveRec(env, rec);
              continue;
            }
            f.size = real;
            rec.totalSize = rec.files.reduce((a, x) => a + x.size, 0);
            await saveRec(env, rec);
          }
          // 途中から読めるかを、入れ始める前に 1 回だけ聞く（途中まで入っているものは読めると分かっている）
          // 第21版：前に分割で入れ始めて 1 個も入っていないもの・メモリの上限に当たったものも聞き直す
          if (f.forceStream || !f.r2UploadId || !(f.r2Parts?.length)) {
            const pr = f.forceStream ? { size: f.size, ranged: false } : await probeZoom(zoom, f.url);
            if (!pr.ranged) {
              out(`      このファイルは途中から読めないので、流しながら入れます（${(f.size / 1048576).toFixed(0)} MB）`);
              const okStream = await streamZoomToR2(env, zoom, f, deadline, out, beat);
              await saveRec(env, rec);
              if (okStream) res.movedBytes += f.size;
              else break;
              continue;
            }
          }
          const before = (f.r2Parts?.length ?? 0) * LEGACY_CHUNK;
          const token = zoom;
          // 途中経過は f そのものに書かせる（写しを渡すと控えに残らない）
          const progress = f as LegacyFile & { recId: string };
          progress.recId = rec.uuid;
          const finished = await sendToR2(
            env,
            progress,
            f.size,
            LEGACY_CHUNK,
            (s, e) => readZoomRange(token, f.url, s, e),
            async () => saveRec(env, rec),
            out,
            beat,
            stop,
          ).catch(async (e) => {
            // 第21版：途中から読む頼みでメモリの上限に当たったら、次の実行は流しながら入れる
            if (/Memory limit/i.test(e instanceof Error ? e.message : String(e))) {
              f.forceStream = true;
              f.r2UploadId = undefined;
              f.r2Parts = undefined;
            }
            await saveRec(env, rec);
            throw e;
          });
          void finished;
          res.movedBytes += Math.max(0, (f.r2Done ? f.size : (f.r2Parts?.length ?? 0) * LEGACY_CHUNK) - before);
        }
        if (rec.files.every((f) => f.r2Done)) {
          rec.r2Done = true;
          rec.lastError = undefined;
          await saveRec(env, rec);
          out("  全部 R2 に入った");
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        rec.lastError = why.slice(0, 500);
        await saveRec(env, rec);
        res.errors.push(`${rec.date}：${why.slice(0, 200)}`);
        out(`  エラー：${why}`);
      }
    }
    for (const r of recs) {
      if (r.r2DeletedAt) continue;
      if (r.r2Done) res.done++;
      else res.remainingBytes += r.files.filter((f) => !f.r2Done).reduce((a, f) => a + f.size, 0);
      if (r.match) res.matched[r.match.kind]++;
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }
  return res;
}

/** 一覧（ArchiveApi）へ出す行。古い録画の控えを全部読む */
export async function legacyRows(env: ArchiveEnv): Promise<LegacyRec[]> {
  const out: LegacyRec[] = [];
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await env.STORE.list({ prefix: REC_PREFIX, cursor });
    for (const o of page.objects) {
      const r = await loadJson<LegacyRec>(env, o.key);
      if (r) out.push(r);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}
