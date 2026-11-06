/**
 * zoom-to-youtube / archive.ts（第18版・2026-11-02 開発部・経理系の依頼 1 便 1）
 *
 * Zoom の録画を自動で保管するための部品。index.ts の流れに 3 か所で差し込む。
 *   1. 見つける：Zoom の録画一覧から新しい録画を拾い、受け付けの台帳に行を足す（人が貼らなくてよくなる）
 *   2. 名前を付ける：文字起こしを Workers AI に読ませて、タイトル・概要欄・R2 のファイル名を作る
 *   3. 原本を R2 へ：Zoom から 8 MB ずつ読んで、R2 の分割アップロードへ渡す
 * 一覧は ArchiveApi（RPC）で返す。限定公開の住所が載るので、誰でも開ける口にはしない。
 *
 * 決め（2026-11-02 Naoki OK の「作る前の 1 枚」）
 *   ・会員の名前はタイトル・概要欄・ファイル名に入れない。AI に渡す前に話者の名前を「話者A」に置き換え、
 *     出てきた名前付けに話者の名前か「〜さん」が入っていたら使わずに、日付_会の名前_録画 にする
 *   ・Zoom の会議名は AI に渡さない（会員の名前が入っていることがあるため）
 *   ・Zoom から消すのは便 3。この版では消さない
 */

/* ------------------------------------------------------------------ */
/* 型                                                                  */
/* ------------------------------------------------------------------ */

export interface ArchiveEnv {
  STORE: R2Bucket;
  AI?: Ai;
  ZOOM_ACCOUNT_ID?: string;
  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
  ALLOWED_EMAIL?: string;
}

/** 名前付けの結果。job に残す */
export interface Naming {
  /** ai＝AI が付けた／blocked＝名前が混ざったので止めた／no_transcript＝文字起こしが無い／failed＝AI が答えなかった */
  mode: "ai" | "blocked" | "no_transcript" | "failed";
  kai: string;
  topic: string;
  /** YouTube のタイトル（人が台帳に題名を入れた行は、その題名を使う） */
  title: string;
  description: string;
  /** 止めた・失敗したときの理由（名前そのものは書かない） */
  note?: string;
}

export const KAI = ["セミナー", "Zoom添削", "個別相談", "打ち合わせ", "その他"] as const;

/** 自動で台帳に足すのは、この時刻より後に始まった録画だけ（それより前は便 2 で移す） */
export const AUTO_FROM = "2026-11-02T00:00:00+09:00";

/** 文字起こしが付くのを待つ長さ。録画の終わりからこれだけ過ぎても無ければ、文字起こし無しで進める */
const TRANSCRIPT_WAIT_MS = 6 * 60 * 60 * 1000;

const AI_MODEL = "@cf/openai/gpt-oss-120b";
/** AI に渡す文字起こしの上限（文字数）。長い回は前から詰めた要約の行を間引く */
const AI_INPUT_LIMIT = 60000;

export const R2_PREFIX = "recordings/";
const SEEN_PREFIX = "auto/seen/";
const ZOOM_USER_KEY = "config/zoom-user.json";
const DISCOVER_ERROR_KEY = "auto/last-error.json";

/* ------------------------------------------------------------------ */
/* 日付・名前の小物                                                    */
/* ------------------------------------------------------------------ */

function jstParts(ms: number): { date: string; y: string; m: string } {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return { date: `${y}-${m}-${String(d.getUTCDate()).padStart(2, "0")}`, y, m };
}

/** ファイル名に使えない文字を落とし、長さをそろえる */
export function fileSafe(s: string, max = 40): string {
  return s.replace(/[\\/:*?"<>|#%{}^~\[\]`]/g, "").replace(/\s+/g, "").trim().slice(0, max) || "録画";
}

/** R2 の置き場の名前（日付_会の名前_話題）。同じ名前が既にあれば _2, _3 … を付ける */
export async function decideR2Key(env: ArchiveEnv, date: string, kai: string, topic: string): Promise<string> {
  const [y, m] = date.split("-");
  const base = `${R2_PREFIX}${y}/${m}/${date}_${fileSafe(kai, 12)}_${fileSafe(topic)}`;
  for (let n = 1; n < 50; n++) {
    const key = n === 1 ? `${base}.mp4` : `${base}_${n}.mp4`;
    if (!(await env.STORE.head(key))) return key;
  }
  return `${base}_${Date.now().toString(36)}.mp4`;
}

/* ------------------------------------------------------------------ */
/* 名前付け                                                            */
/* ------------------------------------------------------------------ */

interface Cue {
  sec: number;
  who: string;
  text: string;
}

function toSec(t: string): number {
  const m = t.match(/(\d+):(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length || /^WEBVTT/.test(lines[0])) continue;
    const timeLine = lines.find((l) => l.includes("-->")) ?? "";
    const body = lines.filter((l) => !/^\d+$/.test(l) && !l.includes("-->")).join(" ").trim();
    if (!body) continue;
    const m = body.match(/^([^:：]{1,30})[:：]\s*(.*)$/);
    cues.push({ sec: toSec(timeLine), who: m ? m[1].trim() : "", text: (m ? m[2] : body).trim() });
  }
  return cues.filter((c) => c.text);
}

function mmss(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * AI に渡す本文を作る。話者の名前は「話者A・B…」に置き換え、30 秒ごとに 1 行へまとめて時刻を付ける。
 * 長すぎる回は行を間引いて上限に収める（目次の時刻が全体に散るように、均等に間引く）。
 */
export function aiInput(cues: Cue[]): { text: string; speakers: string[] } {
  const speakers = [...new Set(cues.map((c) => c.who).filter(Boolean))];
  const alias = new Map(speakers.map((s, i) => [s, `話者${String.fromCharCode(65 + (i % 26))}`]));
  const lines: string[] = [];
  let cur: { sec: number; parts: string[] } | null = null;
  let lastWho = "";
  for (const c of cues) {
    if (!cur || c.sec - cur.sec >= 30) {
      if (cur) lines.push(`[${mmss(cur.sec)}] ${cur.parts.join("")}`);
      cur = { sec: c.sec, parts: [] };
      lastWho = "";
    }
    const who = c.who ? (alias.get(c.who) as string) : "";
    cur.parts.push(who && who !== lastWho ? `${who}「${c.text}」` : c.text);
    lastWho = who || lastWho;
  }
  if (cur) lines.push(`[${mmss(cur.sec)}] ${cur.parts.join("")}`);
  let text = lines.join("\n");
  if (text.length > AI_INPUT_LIMIT) {
    const keep = Math.max(1, Math.floor((lines.length * AI_INPUT_LIMIT) / text.length));
    const step = lines.length / keep;
    const picked: string[] = [];
    for (let i = 0; i < keep; i++) picked.push(lines[Math.floor(i * step)].slice(0, 400));
    text = picked.join("\n");
  }
  return { text: replaceNames(text, speakers), speakers };
}

/** 話者の名前の部品（空白で分けた 2 文字以上の部分も含む） */
function namePieces(speakers: string[]): string[] {
  const out = new Set<string>();
  for (const s of speakers) {
    const t = s.trim();
    if (t.length >= 2) out.add(t);
    for (const p of t.split(/[\s　・_\-()（）]+/)) if (p.length >= 2) out.add(p);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** 本文の中で話者の名前が呼ばれているところも伏せる */
function replaceNames(text: string, speakers: string[]): string {
  let out = text;
  for (const p of namePieces(speakers)) out = out.split(p).join("（名前）");
  return out;
}

/** 名前付けに人の名前が混ざっていないか。混ざっていれば理由を返す（名前そのものは返さない） */
export function nameLeak(fields: string[], speakers: string[]): string | null {
  const all = fields.join("\n");
  for (const p of namePieces(speakers)) if (all.includes(p)) return "話者の名前が入っていた";
  // 人を指さない言い方（皆さん・お客さん など）は外してから見る
  const rest = all.replace(/皆さん|みなさん|皆様|みなさま|お客さん|お客様|生徒さん|受講生さん|受講者さん|参加者さん/g, "");
  if (/[一-龥ぁ-んァ-ヶーA-Za-z]{1,10}(さん|様|さま|ちゃん)/.test(rest)) return "「〜さん」の形の呼び名が入っていた";
  if (all.includes("（名前）")) return "伏せた名前の印が入っていた";
  return null;
}

const INSTRUCTIONS = [
  "あなたは、日本語の講座やミーティングの録画に、内容が分かる名前を付ける係です。",
  "渡すのは Zoom の文字起こしです。行の頭の [分:秒] はその行が始まる時刻です。話者は「話者A」のように伏せてあり、本文中の人名は（名前）に置き換えてあります。",
  "次の JSON だけを返してください。前後に説明を書かないでください。",
  '{"kai":"…","topic":"…","summary":["…","…","…"],"chapters":[{"t":"0:00","title":"…"}]}',
  "kai：次の 5 つから 1 つ。セミナー（講師が多人数へ教える）／Zoom添削（受講生の文章や成果物を添削する）／個別相談（1 人の相談に乗る）／打ち合わせ（仕事の段取り）／その他",
  "topic：何の話かが一目で分かる 25 文字以内の名詞句。記号は使わない。",
  "summary：内容の要約をちょうど 3 行。1 行 60 文字以内。",
  "chapters：話題が変わるところの目次。最初は必ず 0:00。3〜12 個。時刻は文字起こしの [分:秒] から取る。題は 20 文字以内。",
  "絶対に守ること：人の名前・あだ名・会社名・「〜さん」の呼び方を、どの欄にも書かない。参加者が誰かが分かることも書かない。",
].join("\n");

export function outputText(res: unknown): string {
  if (typeof res === "string") return res;
  const r = res as { output_text?: string; response?: unknown; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  if (typeof r?.output_text === "string") return r.output_text;
  if (typeof r?.response === "string") return r.response;
  const texts: string[] = [];
  for (const item of r?.output ?? []) {
    if (item.type && item.type !== "message") continue;
    for (const c of item.content ?? []) if (typeof c.text === "string") texts.push(c.text);
  }
  return texts.join("\n");
}

export function parseJson(s: string): Record<string, unknown> | null {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim().slice(0, max) : "";
}

/** 目次の時刻を秒に。読めなければ -1 */
function chapterSec(t: string): number {
  const p = t.trim().split(":").map(Number);
  if (p.some((n) => !Number.isFinite(n))) return -1;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : -1;
}

/** 概要欄を組む。目次は YouTube の決まり（最初が 0:00・3 つ以上・10 秒以上あける）を満たすときだけ載せる */
export function buildDescription(summary: string[], chapters: { t: string; title: string }[], durationSec: number): string {
  const lines = summary.filter(Boolean).slice(0, 3);
  const ch: { sec: number; title: string }[] = [];
  for (const c of chapters) {
    const sec = chapterSec(c.t);
    if (sec < 0 || (durationSec > 0 && sec >= durationSec) || !c.title) continue;
    if (ch.length && sec - ch[ch.length - 1].sec < 10) continue;
    ch.push({ sec, title: c.title });
  }
  if (ch.length && ch[0].sec !== 0) ch.unshift({ sec: 0, title: "はじめに" });
  const out = [...lines];
  if (ch.length >= 3) {
    out.push("", "目次");
    for (const c of ch) out.push(`${mmss(c.sec)} ${c.title}`);
  }
  return out.join("\n").slice(0, 4900);
}

function fallback(date: string, humanTitle: string, mode: Naming["mode"], note?: string): Naming {
  const topic = humanTitle ? fileSafe(humanTitle) : "録画";
  return { mode, kai: "その他", topic, title: humanTitle || `${date}｜その他｜録画`, description: "", note };
}

/**
 * 録画 1 本に名前を付ける。失敗しても投げない（保管を止めないため）。
 * humanTitle：台帳に人が入れた題名。あればタイトルはそれを使い、AI は会の名前・概要欄・ファイル名の話題だけ作る。
 */
export async function nameRecording(
  env: ArchiveEnv,
  vtt: string | null,
  date: string,
  durationSec: number,
  humanTitle: string,
): Promise<Naming> {
  if (!vtt) return fallback(date, humanTitle, "no_transcript", "文字起こしが無い");
  if (!env.AI) return fallback(date, humanTitle, "failed", "Workers AI の結び（AI）が無い");
  const cues = parseVtt(vtt);
  if (cues.length === 0) return fallback(date, humanTitle, "no_transcript", "文字起こしが空");
  const { text, speakers } = aiInput(cues);

  let got: Record<string, unknown> | null = null;
  let why = "";
  for (let attempt = 0; attempt < 2 && !got; attempt++) {
    try {
      const res = await env.AI.run(AI_MODEL as keyof AiModels, {
        instructions: INSTRUCTIONS,
        input: text,
        reasoning: { effort: "low" },
      } as never);
      got = parseJson(outputText(res));
      if (!got) why = "AI の答えが JSON で読めなかった";
    } catch (e) {
      why = `AI が答えなかった：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  }
  if (!got) return fallback(date, humanTitle, "failed", why);

  const kaiRaw = clean(got.kai, 12);
  const kai = (KAI as readonly string[]).includes(kaiRaw) ? kaiRaw : "その他";
  const topic = clean(got.topic, 40);
  const summary = Array.isArray(got.summary) ? got.summary.map((s) => clean(s, 80)) : [];
  const chapters = Array.isArray(got.chapters)
    ? (got.chapters as { t?: unknown; title?: unknown }[]).map((c) => ({ t: clean(c?.t, 10), title: clean(c?.title, 30) }))
    : [];
  if (!topic) return fallback(date, humanTitle, "failed", "AI が話題を返さなかった");

  const description = buildDescription(summary, chapters, durationSec);
  const title = humanTitle || `${date}｜${kai}｜${topic}`.slice(0, 100);
  // 人が入れた題名は人の判断なので照合しない。AI が作った部分だけを照合する
  const leak = nameLeak([kai, topic, description, humanTitle ? "" : title], speakers);
  if (leak) return { ...fallback(date, humanTitle, "blocked", leak), kai };
  return { mode: "ai", kai, topic, title, description };
}

/* ------------------------------------------------------------------ */
/* Zoom の録画一覧から新しい録画を見つける                             */
/* ------------------------------------------------------------------ */

export interface ZoomRecFile {
  id?: string;
  file_type?: string;
  file_extension?: string;
  file_size?: number;
  download_url?: string;
  recording_type?: string;
  recording_start?: string;
  recording_end?: string;
  status?: string;
}

export interface ZoomMeeting {
  uuid?: string;
  topic?: string;
  start_time?: string;
  duration?: number;
  total_size?: number;
  share_url?: string;
  recording_play_passcode?: string;
  recording_files?: ZoomRecFile[];
}

export async function zoomToken(env: ArchiveEnv): Promise<string> {
  if (!env.ZOOM_ACCOUNT_ID || !env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) {
    throw new Error("Zoom 本体の口の設定（ZOOM_ACCOUNT_ID・ZOOM_CLIENT_ID・ZOOM_CLIENT_SECRET）が足りません");
  }
  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: env.ZOOM_ACCOUNT_ID }),
  });
  const b = (await res.json()) as { access_token?: string; reason?: string; error?: string };
  if (!res.ok || !b.access_token) throw new Error(`Zoom の鍵が取れません（${res.status}／${b.reason ?? b.error ?? "理由なし"}）`);
  return b.access_token;
}

/**
 * 録画の一覧を取る。誰の録画かは me → 許可したメール の順に試し、通った方を控える。
 * どちらも断られたら、Zoom の返事（足りない許可の名前が入る）をそのまま投げる。
 */
export async function listZoomRecordings(env: ArchiveEnv, fromDate: string, toDate: string): Promise<ZoomMeeting[]> {
  const token = await zoomToken(env);
  const saved = await env.STORE.get(ZOOM_USER_KEY);
  const tries = saved
    ? [(JSON.parse(await saved.text()) as { user: string }).user]
    : ["me", ...(env.ALLOWED_EMAIL ? [env.ALLOWED_EMAIL.trim()] : [])];
  const errors: string[] = [];
  for (const user of tries) {
    const meetings: ZoomMeeting[] = [];
    let next = "";
    let ok = true;
    for (let guard = 0; guard < 20; guard++) {
      const url =
        `https://api.zoom.us/v2/users/${encodeURIComponent(user)}/recordings?page_size=300&from=${fromDate}&to=${toDate}` +
        (next ? `&next_page_token=${encodeURIComponent(next)}` : "");
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const raw = await res.text();
      if (!res.ok) {
        errors.push(`${user === "me" ? "me" : "許可したメール"}：${res.status}／${raw.slice(0, 300)}`);
        ok = false;
        break;
      }
      const body = JSON.parse(raw) as { meetings?: ZoomMeeting[]; next_page_token?: string };
      meetings.push(...(body.meetings ?? []));
      next = body.next_page_token ?? "";
      if (!next) break;
    }
    if (ok) {
      if (!saved) await env.STORE.put(ZOOM_USER_KEY, JSON.stringify({ user, at: new Date().toISOString() }));
      return meetings;
    }
  }
  throw new Error(`Zoom が録画の一覧を返しません（${errors.join("／")}）`);
}

function seenKey(uuid: string): string {
  return SEEN_PREFIX + uuid.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
}

export interface DiscoverResult {
  added: { date: string; uuid: string }[];
  waiting: number;
  skipped: number;
  error?: string;
}

/**
 * 新しい録画を見つけて、台帳に足す行を返す（書くのは呼ぶ側）。
 * 足すのは：AUTO_FROM より後に始まり・動画の処理が終わり・文字起こしが付いた（または 6 時間待った）・まだ足していない録画。
 * 共有リンクは share_url に再生の合言葉を付けたもの（Zoom の説明どおり ?pwd= でつなぐ）。
 */
export async function discoverNew(
  env: ArchiveEnv,
  appendRow: (share: string) => Promise<void>,
): Promise<DiscoverResult> {
  const now = Date.now();
  const from = Math.max(Date.parse(AUTO_FROM), now - 29 * 86400000);
  const result: DiscoverResult = { added: [], waiting: 0, skipped: 0 };
  try {
    const meetings = await listZoomRecordings(env, jstParts(from).date, jstParts(now + 86400000).date);
    for (const m of meetings) {
      if (!m.uuid || !m.share_url || !m.start_time) continue;
      if (Date.parse(m.start_time) < Date.parse(AUTO_FROM)) {
        result.skipped++;
        continue;
      }
      if (await env.STORE.head(seenKey(m.uuid))) continue;
      const files = m.recording_files ?? [];
      const videos = files.filter((f) => (f.file_type ?? "").toUpperCase() === "MP4");
      if (!videos.length || videos.some((f) => (f.status ?? "").toLowerCase() !== "completed")) {
        result.waiting++;
        continue;
      }
      const hasTranscript = files.some(
        (f) => (f.file_type ?? "").toUpperCase() === "TRANSCRIPT" && (f.status ?? "").toLowerCase() === "completed",
      );
      const ended = Math.max(...files.map((f) => Date.parse(f.recording_end ?? "") || 0));
      if (!hasTranscript && now - ended < TRANSCRIPT_WAIT_MS) {
        result.waiting++;
        continue;
      }
      const share = m.recording_play_passcode
        ? `${m.share_url}${m.share_url.includes("?") ? "&" : "?"}pwd=${encodeURIComponent(m.recording_play_passcode)}`
        : m.share_url;
      await appendRow(share);
      const date = jstParts(Date.parse(m.start_time)).date;
      await env.STORE.put(seenKey(m.uuid), JSON.stringify({ uuid: m.uuid, date, addedAt: new Date().toISOString() }));
      result.added.push({ date, uuid: m.uuid });
    }
    await env.STORE.delete(DISCOVER_ERROR_KEY);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await env.STORE.put(DISCOVER_ERROR_KEY, JSON.stringify({ at: new Date().toISOString(), error: result.error }));
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 原本を R2 へ（分割アップロード）                                    */
/* ------------------------------------------------------------------ */

export interface R2Progress {
  r2Key?: string;
  r2UploadId?: string;
  r2Parts?: { partNumber: number; etag: string }[];
  r2Done?: boolean;
}

/**
 * Zoom から 8 MB ずつ読んで R2 の分割アップロードへ渡す。途中経過（どの部品まで入ったか）は job に残し、
 * 次の実行は続きから入れる。分割の部品は最後以外すべて同じ大きさ（R2 の決まり）。
 * 終わったら R2 の大きさを Zoom の大きさと突き合わせ、違えば投げる。
 */
export async function sendToR2(
  env: ArchiveEnv,
  p: R2Progress & { recId: string },
  size: number,
  chunk: number,
  readRange: (start: number, end: number) => Promise<ArrayBuffer>,
  save: () => Promise<void>,
  out: (s: string) => void,
  beat: () => Promise<void>,
  /** 第19版：true を返したら、そこまでを控えに残して止まる（続きは次の実行）。止まったときは false を返す */
  shouldStop?: () => boolean,
): Promise<boolean> {
  if (!p.r2Key) throw new Error("R2 の置き場の名前が決まっていません");
  const key = p.r2Key;
  const done = await env.STORE.head(key);
  if (done && done.size === size) {
    p.r2Done = true;
    p.r2UploadId = undefined;
    p.r2Parts = undefined;
    await save();
    out("      R2 には入っていました");
    return true;
  }

  let upload: R2MultipartUpload | null = null;
  if (p.r2UploadId && p.r2Parts) {
    upload = env.STORE.resumeMultipartUpload(key, p.r2UploadId);
    out(`      続きから入れます（${p.r2Parts.length} 個まで済み）`);
  }
  if (!upload) {
    upload = await env.STORE.createMultipartUpload(key, {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { recId: p.recId },
    });
    p.r2UploadId = upload.uploadId;
    p.r2Parts = [];
    await save();
  }
  const parts = p.r2Parts as { partNumber: number; etag: string }[];

  const t0 = Date.now();
  try {
    let sent = parts.length * chunk;
    while (sent < size) {
      if (shouldStop?.()) {
        await save();
        await beat();
        out(`      ここで止めて、続きは次の実行で入れます（${(sent / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB）`);
        return false;
      }
      const end = Math.min(sent + chunk, size) - 1;
      const buf = await readRange(sent, end);
      if (buf.byteLength !== end - sent + 1) {
        throw new Error(`Zoom から読めた大きさが合いません（${buf.byteLength} バイト・欲しかったのは ${end - sent + 1}）`);
      }
      const part = await upload.uploadPart(parts.length + 1, buf);
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      sent += buf.byteLength;
      // 控えの書き直しと錠の押し直しは 4 個（32 MB）ごと。落ちても、控えに無い部品は次の実行が入れ直すだけ
      if (parts.length % 4 === 0 || sent >= size) {
        await save();
        await beat();
      }
      out(`      R2 ${(sent / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    }
    await upload.complete(parts);
  } catch (e) {
    // 分割アップロードが期限切れ・消えていたときは、最初から入れ直す（次の実行で）
    const why = e instanceof Error ? e.message : String(e);
    if (/upload|NoSuchUpload|not found/i.test(why) && !/Zoom/.test(why)) {
      p.r2UploadId = undefined;
      p.r2Parts = undefined;
      await save();
    }
    throw new Error(`R2 へ入れる途中で止まりました：${why}`);
  }

  const head = await env.STORE.head(key);
  if (!head || head.size !== size) {
    throw new Error(`R2 の大きさが Zoom と合いません（R2 ${head?.size ?? "無し"}・Zoom ${size}）`);
  }
  p.r2Done = true;
  p.r2UploadId = undefined;
  p.r2Parts = undefined;
  await save();
  return true;
}

/* ------------------------------------------------------------------ */
/* 一覧（RPC・shia2n-mcp の道具 zoom_archive__list から呼ぶ）          */
/* ------------------------------------------------------------------ */

export interface ArchiveRow {
  rec_id: string;
  date: string;
  title: string;
  r2: boolean;
  r2_key: string | null;
  youtube: boolean;
  youtube_url: string | null;
  zoom_deleted: boolean;
  zoom_deleted_at: string | null;
  naming: string;
  naming_note: string | null;
  updated_at: string;
  /** 第19版：new＝11/02 以降に録った録画（台帳から）／legacy＝それより前の録画（便 2 で移す） */
  kind: "new" | "legacy";
  /** 第19版：会議 1 回ぶんの大きさ（GB） */
  size_gb: number | null;
  /** 第21版：会の名前（セミナー・Zoom添削・個別相談・打ち合わせ・その他） */
  kai: string | null;
  /** 第21版：探す・消す道具で R2 から消した日時 */
  r2_deleted_at: string | null;
}

export interface ArchiveListResult {
  ok: true;
  count: number;
  counts: { r2: number; youtube: number; both: number; zoom_deleted: number };
  rows?: ArchiveRow[];
  /** 第19版：古い録画の移しの進み具合 */
  legacy: { total: number; r2_done: number; remaining_gb: number; youtube_none: number };
  failure_count: number;
  failures: { where: string; what: string; error: string }[];
}

type JobLike = R2Progress & {
  recId: string;
  title?: string;
  date?: string;
  size?: number;
  youtubeUrl?: string;
  naming?: Naming;
  zoomDeletedAt?: string;
  r2DeletedAt?: string;
  lastError?: string;
  updatedAt?: string;
};

/** job/ の控えを全部読んで、録画 1 本ごとの 1 行にする。失敗は rows とは別に返す */
export async function buildArchiveList(
  env: ArchiveEnv,
  sheetFailures: () => Promise<{ where: string; what: string; error: string }[]>,
): Promise<ArchiveListResult> {
  const rows: ArchiveRow[] = [];
  const failures: { where: string; what: string; error: string }[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await env.STORE.list({ prefix: "job/", cursor });
    for (const o of page.objects) {
      const got = await env.STORE.get(o.key);
      if (!got) continue;
      let j: JobLike;
      try {
        j = JSON.parse(await got.text()) as JobLike;
      } catch {
        failures.push({ where: "控え", what: o.key, error: "控えが JSON で読めない" });
        continue;
      }
      rows.push({
        rec_id: j.recId,
        date: j.date ?? "",
        title: j.naming?.title ?? j.title ?? "",
        r2: !!j.r2Done && !j.r2DeletedAt,
        r2_key: j.r2Done && !j.r2DeletedAt ? (j.r2Key ?? null) : null,
        youtube: !!j.youtubeUrl,
        youtube_url: j.youtubeUrl ?? null,
        zoom_deleted: !!j.zoomDeletedAt,
        zoom_deleted_at: j.zoomDeletedAt ?? null,
        naming: j.naming?.mode ?? "未",
        naming_note: j.naming?.note ?? null,
        updated_at: j.updatedAt ?? "",
        kind: "new",
        size_gb: j.size ? Math.round((j.size / 1073741824) * 100) / 100 : null,
        kai: j.naming?.kai ?? null,
        r2_deleted_at: j.r2DeletedAt ?? null,
      });
      if (j.lastError) failures.push({ where: "録画", what: `${j.date ?? ""} ${j.title ?? j.recId}`, error: j.lastError });
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  // 第19版：古い録画の行を足す。台帳の控えと結び付いた録画は、控えの行を外して古い録画の行 1 本にする
  const legacy = { total: 0, r2_done: 0, remaining_gb: 0, youtube_none: 0 };
  if (legacyReader) {
    const got = await legacyReader(env);
    const covered = new Set(got.coveredJobRecIds);
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "new" && covered.has(rows[i].rec_id) && !rows[i].r2) rows.splice(i, 1);
    rows.push(...got.rows);
    failures.push(...got.failures);
    Object.assign(legacy, got.summary);
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const disc = await env.STORE.get(DISCOVER_ERROR_KEY);
  if (disc) {
    const d = JSON.parse(await disc.text()) as { at: string; error: string };
    failures.push({ where: "見つける", what: `Zoom の録画一覧（${d.at}）`, error: d.error });
  }
  try {
    failures.push(...(await sheetFailures()));
  } catch (e) {
    failures.push({ where: "台帳", what: "受け付けの台帳", error: `読めなかった：${e instanceof Error ? e.message : String(e)}` });
  }
  return {
    ok: true,
    count: rows.length,
    counts: {
      r2: rows.filter((r) => r.r2).length,
      youtube: rows.filter((r) => r.youtube).length,
      both: rows.filter((r) => r.r2 && r.youtube).length,
      zoom_deleted: rows.filter((r) => r.zoom_deleted).length,
    },
    rows,
    legacy,
    failure_count: failures.length,
    failures,
  };
}

/** 第19版：index.ts から古い録画の行の読み方を差し込む（legacy.ts が archive.ts を使うので、逆向きに読まない） */
export interface LegacyReadout {
  rows: ArchiveRow[];
  failures: { where: string; what: string; error: string }[];
  coveredJobRecIds: string[];
  summary: { total: number; r2_done: number; remaining_gb: number; youtube_none: number };
}
let legacyReader: ((env: ArchiveEnv) => Promise<LegacyReadout>) | null = null;
export function setLegacyReader(f: typeof legacyReader): void {
  legacyReader = f;
}

/** index.ts から台帳の失敗の読み方を差し込む（Google の鍵まわりは index.ts が持つ） */
let sheetFailureReader: ((env: ArchiveEnv) => Promise<{ where: string; what: string; error: string }[]>) | null = null;
export function setSheetFailureReader(f: typeof sheetFailureReader): void {
  sheetFailureReader = f;
}

/** 第21版：台帳の失敗の読み方を外（api.ts）から使う */
export async function readSheetFailures(env: ArchiveEnv): Promise<{ where: string; what: string; error: string }[]> {
  return sheetFailureReader ? sheetFailureReader(env) : [];
}
