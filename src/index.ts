/**
 * zoom-to-youtube / 第5版（2026-08-21 開発部・段階 C）
 *
 * できること
 *   /setup/sheet   管理用スプレッドシートを1枚作る（すでにあれば作らない）
 *   /run           シートを見て、通すべき行を1本ずつ進める（途中経過が出る）
 *   /oauth/*       Google の許可（2本）
 *   5分ごとの自動実行（同じ処理を静かに動かす）
 *
 * 動画の運び方
 *   Zoom から 8 MB ずつ読んで、そのまま Google へ渡す。全体を溜め込まないので
 *   メモリの枠（128 MB）に触れない。Zoom は途中からの読み出しに対応している。
 *
 * 第5版で足したこと（段階 C）
 *   1. 途中経過を録画ごとに R2 へ残す（job/ の下）。8 MB 進むたびに書き直す
 *   2. 途中で切れた行と、エラーになった行を、次の実行が自動で拾い直して続きから進める
 *   3. すでに YouTube へ上がっている録画は、二度と上げない
 *   4. 錠は動いている間ずっと押し直す。3分押されていなければ、前の実行は落ちたものとみなす
 *   5. 1回の実行は10分で自分から畳む。残りは次の自動実行が続ける
 *
 * 残る限界（分かったうえで、そのままにしてある）
 *   Google の鍵は1時間で切れる。1本の送り出しが1時間を超えると途中で止まるが、
 *   そこまでの進み具合は残っているので、次の実行が続きから進める。
 */

interface Env {
  STORE: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_EMAIL?: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ZOOM_BASE = "https://us02web.zoom.us";
const CHUNK = 8 * 1024 * 1024;
const ROOT_FOLDER = "講義コンテンツ";
const SHEET_KEY = "config/sheet.json";
const LOCK_KEY = "run/lock";
const JOB_PREFIX = "job/";

/** 錠がこの時間だけ押し直されていなければ、前の実行は落ちたものとみなす */
const LOCK_STALE_MS = 3 * 60 * 1000;

/** 1回の実行はこの時間で自分から畳む（残りは次の自動実行が続ける） */
const RUN_BUDGET_MS = 10 * 60 * 1000;

/** 処理の途中を表す状態。この状態のまま残っている行は、前の実行が落ちた残り */
const MIDWAY: string[] = ["Zoom取得中", "Drive保存済み", "YouTube投稿中"];

const HEADERS = [
  "処理ID",
  "Zoom共有URL",
  "講義タイトル",
  "収録日",
  "DriveフォルダURL",
  "YouTube URL",
  "処理状態",
  "エラー内容",
  "最終更新日時",
] as const;

const COL = {
  id: 0,
  share: 1,
  title: 2,
  date: 3,
  drive: 4,
  youtube: 5,
  state: 6,
  error: 7,
  updated: 8,
} as const;

const PERMITS = {
  youtube: {
    label: "YouTube へ動画を上げる許可（ブランドアカウントで通す）",
    key: "auth/youtube.json",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ].join(" "),
  },
  workspace: {
    label: "ドライブへ保存し、シートに書き戻す許可（ふだんの Google アカウントで通す）",
    key: "auth/workspace.json",
    scopes: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/spreadsheets",
      "openid",
      "email",
    ].join(" "),
  },
} as const;

type PermitName = keyof typeof PERMITS;

function isPermitName(v: string | null): v is PermitName {
  return v === "youtube" || v === "workspace";
}

interface StoredAuth {
  refresh_token: string;
  scope: string;
  obtained_at: string;
  email?: string;
  channel_id?: string;
  channel_title?: string;
}

/** 1本ぶんの途中経過。録画ごとに1つ、R2 に残す */
interface Job {
  pid: string;
  share: string;
  rowNo: number;
  title: string;
  date: string;
  size: number;
  driveFolderId?: string;
  driveFolderUrl?: string;
  transcriptDone?: boolean;
  driveSession?: string;
  driveDone?: boolean;
  ytSession?: string;
  youtubeId?: string;
  youtubeUrl?: string;
  privacy?: string;
  updatedAt: string;
}

/** 受け口が期限切れになったときに投げる */
class SessionGone extends Error {}

function jobKey(pid: string): string {
  return JOB_PREFIX + pid.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
}

async function loadJob(env: Env, pid: string): Promise<Job | null> {
  const o = await env.STORE.get(jobKey(pid));
  if (!o) return null;
  return JSON.parse(await o.text()) as Job;
}

async function saveJob(env: Env, job: Job): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await env.STORE.put(jobKey(job.pid), JSON.stringify(job));
}

/* ================================================================== */
/* 小物                                                                */
/* ================================================================== */

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const sec = (ms: number) => (ms / 1000).toFixed(1);
const mb = (b: number) => (b / 1024 / 1024).toFixed(1);

function readIdToken(idToken: string): { email?: string } {
  const part = idToken.split(".")[1];
  if (!part) return {};
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

function missingSetup(env: Env): string[] {
  const m: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) m.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) m.push("GOOGLE_CLIENT_SECRET");
  if (!env.ALLOWED_EMAIL) m.push("ALLOWED_EMAIL");
  return m;
}

/** 日本時間の年月日にする */
function jst(msUtc: number): { date: string; year: string; ym: string } {
  const d = new Date(msUtc + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear().toString();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return { date: `${y}-${m}-${day}`, year: y, ym: `${y}${m}` };
}

/** Google ドライブのフォルダ名に使えない文字を落とす */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "無題";
}

/* ================================================================== */
/* Google の鍵                                                         */
/* ================================================================== */

async function accessToken(
  env: Env,
  which: PermitName,
): Promise<{ ok: true; token: string } | { ok: false; why: string }> {
  const obj = await env.STORE.get(PERMITS[which].key);
  if (!obj) return { ok: false, why: `${PERMITS[which].label} の控えがありません。/oauth/start から通してください。` };

  const saved = JSON.parse(await obj.text()) as StoredAuth;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      refresh_token: saved.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const b = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !b.access_token) {
    return {
      ok: false,
      why:
        `${b.error ?? res.status}／${b.error_description ?? "説明なし"}` +
        (b.error === "invalid_grant" ? "（許可が切れています。/oauth/start から通し直してください）" : ""),
    };
  }
  return { ok: true, token: b.access_token };
}

async function gFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

async function gJson<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await gFetch(token, url, init);
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google からの返事 ${res.status}：${raw.slice(0, 600)}`);
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

/* ================================================================== */
/* Zoom                                                                */
/* ================================================================== */

class Jar {
  private m = new Map<string, string>();
  absorb(res: Response): void {
    const h = res.headers as unknown as { getSetCookie?: () => string[] };
    for (const raw of typeof h.getSetCookie === "function" ? h.getSetCookie() : []) {
      const first = raw.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) this.m.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.m].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function zHeaders(jar: Jar, referer?: string, accept?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA };
  if (referer) h["Referer"] = referer;
  if (accept) h["Accept"] = accept;
  const ck = jar.header();
  if (ck) h["Cookie"] = ck;
  return h;
}

async function go(jar: Jar, url: string, referer?: string, accept?: string): Promise<{ res: Response; url: string }> {
  let cur = url;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(cur, { headers: zHeaders(jar, referer, accept), redirect: "manual" });
    jar.absorb(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, url: cur };
      await res.body?.cancel();
      cur = new URL(loc, cur).toString();
      continue;
    }
    return { res, url: cur };
  }
  throw new Error("Zoom のリダイレクトが 10 回を超えました");
}

interface ZoomInfo {
  jar: Jar;
  /** 録画そのものの番号。同じ録画かどうかの判定に使う */
  pid: string;
  playUrl: string;
  mp4Url: string;
  transcript: string | null;
  topic: string;
  startedAt: number;
  durationSec: number;
}

async function readZoom(share: string): Promise<ZoomInfo> {
  const jar = new Jar();

  const a = await go(jar, share);
  if (a.res.status !== 200) throw new Error(`Zoom の共有ページが ${a.res.status} を返しました`);
  const html = await a.res.text();
  const m = html.match(/meetingId:\s*'([^']+)'/);
  if (!m) throw new Error("Zoom の共有リンクが無効か、期限切れです（meetingId が見つかりません）");

  const s = await go(jar, `${ZOOM_BASE}/nws/recording/1.0/play/share-info/${m[1]}`, share, "application/json");
  const sj = (await s.res.json()) as { status?: boolean; errorMessage?: string; result?: { redirectUrl?: string } };
  if (!sj.status || !sj.result?.redirectUrl) throw new Error(`Zoom が録画の場所を返しません：${sj.errorMessage ?? "理由なし"}`);

  const pid = sj.result.redirectUrl.split("/").filter(Boolean).pop() as string;
  const playUrl = ZOOM_BASE + sj.result.redirectUrl;

  const p = await go(jar, playUrl, share);
  await p.res.body?.cancel();

  const i = await go(jar, `${ZOOM_BASE}/nws/recording/1.0/play/info/${pid}`, playUrl, "application/json");
  const ij = (await i.res.json()) as { status?: boolean; errorMessage?: string; result?: Record<string, unknown> };
  if (!ij.status || !ij.result) throw new Error(`Zoom が録画の情報を返しません：${ij.errorMessage ?? "理由なし"}`);

  const r = ij.result as {
    meet?: { topic?: string };
    fileStartTime?: number;
    duration?: number;
    mp4Url?: string;
    transcriptUrl?: string;
    disableDownload?: boolean;
  };
  if (r.disableDownload) throw new Error("この録画は取得が禁止に設定されています（Zoom の設定を確認してください）");
  if (!r.mp4Url) throw new Error("Zoom が動画の場所を返しません");

  let transcript: string | null = null;
  if (r.transcriptUrl) {
    const v = await go(jar, ZOOM_BASE + r.transcriptUrl, playUrl);
    if (v.res.ok) transcript = await v.res.text();
    else await v.res.body?.cancel();
  }

  return {
    jar,
    pid,
    playUrl,
    mp4Url: r.mp4Url,
    transcript,
    topic: r.meet?.topic ?? "",
    startedAt: r.fileStartTime ?? Date.now(),
    durationSec: r.duration ?? 0,
  };
}

/* ================================================================== */
/* ドライブ                                                            */
/* ================================================================== */

async function folder(token: string, name: string, parent: string | null): Promise<string> {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    parent ? `'${parent}' in parents` : "'root' in parents",
  ].join(" and ");

  const found = await gJson<{ files?: { id: string }[] }>(
    token,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
  );
  if (found.files?.[0]) return found.files[0].id;

  const made = await gJson<{ id: string }>(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parent ? [parent] : undefined,
    }),
  });
  return made.id;
}

async function putSmallFile(
  token: string,
  name: string,
  parent: string,
  mime: string,
  body: string,
): Promise<string> {
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
  const payload =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [parent] }) +
    `\r\n--${boundary}\r\ncontent-type: ${mime}; charset=UTF-8\r\n\r\n` +
    body +
    `\r\n--${boundary}--`;

  const r = await gJson<{ id: string }>(
    token,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: payload },
  );
  return r.id;
}

/* ================================================================== */
/* 8 MB ずつ運ぶ                                                       */
/* ================================================================== */

/** Google の受け口を1つ開いて、その住所を返す */
async function openSession(token: string, url: string, meta: unknown, size: number, mime: string): Promise<string> {
  const res = await gFetch(token, url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mime,
      "x-upload-content-length": String(size),
    },
    body: JSON.stringify(meta),
  });
  const loc = res.headers.get("location");
  if (!res.ok || !loc) throw new Error(`受け口を開けません ${res.status}：${(await res.text()).slice(0, 600)}`);
  return loc;
}

/** Zoom から 8 MB ずつ読んで、開いた受け口へ渡す */
async function relay(
  z: ZoomInfo,
  size: number,
  session: string,
  token: string,
  from: number,
  out: (s: string) => void,
  beat: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  let sent = from;

  while (sent < size) {
    const end = Math.min(sent + CHUNK, size) - 1;

    const part = await fetch(z.mp4Url, {
      headers: { ...zHeaders(z.jar, z.playUrl), Range: `bytes=${sent}-${end}` },
    });
    if (part.status !== 206 && part.status !== 200) {
      throw new Error(`Zoom が動画の一部を返しません（${part.status}）`);
    }
    const buf = await part.arrayBuffer();

    const put = await gFetch(token, session, {
      method: "PUT",
      headers: {
        "content-range": `bytes ${sent}-${sent + buf.byteLength - 1}/${size}`,
        "content-type": "video/mp4",
      },
      body: buf,
    });

    if (put.status === 308) {
      sent += buf.byteLength;
      await beat();
      out(`      ${mb(sent)} / ${mb(size)} MB（${sec(Date.now() - t0)} 秒）`);
      continue;
    }
    if (put.ok) {
      sent += buf.byteLength;
      await beat();
      out(`      ${mb(sent)} / ${mb(size)} MB（${sec(Date.now() - t0)} 秒）完了`);
      const raw = await put.text();
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    }
    if (put.status === 404 || put.status === 410) {
      await put.body?.cancel();
      throw new SessionGone("受け口の期限が切れました");
    }
    throw new Error(`送り出しが止まりました ${put.status}：${(await put.text()).slice(0, 600)}`);
  }
  throw new Error("送り終えたのに Google から完了の返事がありません");
}

type Probe =
  | { kind: "sent"; sent: number }
  | { kind: "done"; body: Record<string, unknown> }
  | { kind: "gone" };

/** 受け口がどこまで受け取ったかを聞く */
async function askSession(token: string, session: string, size: number): Promise<Probe> {
  const res = await gFetch(token, session, {
    method: "PUT",
    headers: { "content-range": `bytes */${size}` },
  });
  if (res.ok) {
    const raw = await res.text();
    return { kind: "done", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
  }
  if (res.status === 308) {
    const range = res.headers.get("range");
    await res.body?.cancel();
    if (!range) return { kind: "sent", sent: 0 };
    const end = Number(range.split("-")[1]);
    return { kind: "sent", sent: Number.isFinite(end) ? end + 1 : 0 };
  }
  await res.body?.cancel();
  return { kind: "gone" };
}

/** 動画を1か所へ送る。受け口があれば続きから、無ければ開いてから */
async function sendVideo(
  z: ZoomInfo,
  size: number,
  token: string,
  open: () => Promise<string>,
  had: string | undefined,
  remember: (session: string) => Promise<void>,
  out: (s: string) => void,
  beat: () => Promise<void>,
): Promise<Record<string, unknown>> {
  let session = had;
  let from = 0;

  if (session) {
    const asked = await askSession(token, session, size);
    if (asked.kind === "done") {
      out("      すでに送り終えていました");
      return asked.body;
    }
    if (asked.kind === "sent") {
      from = asked.sent;
      out(`      続きから送ります（${mb(from)} / ${mb(size)} MB まで済み）`);
    } else {
      out("      前の受け口はもう使えないので、開き直します");
      session = undefined;
    }
  }

  if (!session) {
    session = await open();
    from = 0;
    await remember(session);
  }

  try {
    return await relay(z, size, session, token, from, out, beat);
  } catch (e) {
    if (!(e instanceof SessionGone)) throw e;
    out("      受け口が途中で使えなくなったので、開き直して最初から送ります");
    const fresh = await open();
    await remember(fresh);
    return await relay(z, size, fresh, token, 0, out, beat);
  }
}

/* ================================================================== */
/* シート                                                              */
/* ================================================================== */

async function sheetId(env: Env): Promise<string | null> {
  const o = await env.STORE.get(SHEET_KEY);
  if (!o) return null;
  return (JSON.parse(await o.text()) as { id: string }).id;
}

async function makeSheet(env: Env, token: string): Promise<{ id: string; url: string; made: boolean }> {
  const existing = await sheetId(env);
  if (existing) return { id: existing, url: `https://docs.google.com/spreadsheets/d/${existing}/edit`, made: false };

  const made = await gJson<{ spreadsheetId: string }>(token, "https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      properties: { title: "Zoom録画の受け付け（zoom-to-youtube）" },
      sheets: [{ properties: { title: "受付", gridProperties: { frozenRowCount: 1 } } }],
    }),
  });

  await gJson(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${made.spreadsheetId}/values/受付!A1?valueInputOption=RAW`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [HEADERS] }) },
  );

  await env.STORE.put(SHEET_KEY, JSON.stringify({ id: made.spreadsheetId, created: new Date().toISOString() }));
  return {
    id: made.spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${made.spreadsheetId}/edit`,
    made: true,
  };
}

async function readRows(token: string, id: string): Promise<string[][]> {
  const r = await gJson<{ values?: string[][] }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent("受付!A2:I500")}`,
  );
  return r.values ?? [];
}

async function writeRow(token: string, id: string, rowNo: number, row: string[]): Promise<void> {
  const padded = [...row];
  while (padded.length < HEADERS.length) padded.push("");
  await gJson(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(
      `受付!A${rowNo}:I${rowNo}`,
    )}?valueInputOption=RAW`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [padded] }) },
  );
}

/* ================================================================== */
/* 1行ぶんの処理                                                       */
/* ================================================================== */

async function processRow(
  env: Env,
  wsToken: string,
  sid: string,
  rowNo: number,
  row: string[],
  out: (s: string) => void,
  beat: () => Promise<void>,
): Promise<void> {
  const set = async (state: string, err = "") => {
    row[COL.state] = state;
    row[COL.error] = err;
    row[COL.updated] = new Date().toISOString();
    await writeRow(wsToken, sid, rowNo, row);
  };

  if (!row[COL.id]) row[COL.id] = `R${Date.now().toString(36)}`;

  try {
    out(`【${rowNo}行目】${row[COL.title] || "（題名なし）"}`);
    await set("Zoom取得中");
    await beat();

    const z = await readZoom(row[COL.share].trim());
    const when = jst(z.startedAt);
    const title = safeName(row[COL.title] || z.topic || "無題");
    row[COL.date] = when.date;
    out(`  収録日 ${when.date} ／ 長さ ${Math.round(z.durationSec / 60)} 分`);

    // 同じ録画がすでに上がっていないか
    let job = await loadJob(env, z.pid);
    if (job?.youtubeUrl && job.rowNo !== rowNo) {
      row[COL.drive] = job.driveFolderUrl ?? "";
      row[COL.youtube] = job.youtubeUrl;
      await set("完了", `同じ録画が ${job.rowNo} 行目ですでに上がっています。上げ直していません`);
      out(`  同じ録画が ${job.rowNo} 行目で上がっているので、上げ直しませんでした`);
      return;
    }

    // 動画の大きさを先に聞く
    const head = await fetch(z.mp4Url, { headers: { ...zHeaders(z.jar, z.playUrl), Range: "bytes=0-0" } });
    const cr = head.headers.get("content-range");
    await head.body?.cancel();
    const size = cr ? Number(cr.split("/")[1]) : 0;
    if (!size) throw new Error("動画の大きさが分かりません（Zoom が content-range を返しません）");
    out(`  動画の大きさ ${mb(size)} MB`);

    if (!job) {
      job = { pid: z.pid, share: row[COL.share].trim(), rowNo, title, date: when.date, size, updatedAt: "" };
    } else {
      job.rowNo = rowNo;
      job.title = title;
      job.date = when.date;
      job.size = size;
      out("  前回の途中経過が残っていました。続きから進めます");
    }
    await saveJob(env, job);
    const j = job;

    // ドライブの置き場を用意する
    if (!j.driveFolderId) {
      const root = await folder(wsToken, ROOT_FOLDER, null);
      const yearId = await folder(wsToken, when.year, root);
      const ymId = await folder(wsToken, when.ym, yearId);
      const dest = await folder(wsToken, `${when.date}_${title}`, ymId);
      j.driveFolderId = dest;
      j.driveFolderUrl = `https://drive.google.com/drive/folders/${dest}`;
      await saveJob(env, j);
      out("  置き場を用意した");
    } else {
      out("  置き場は用意済みです");
    }
    row[COL.drive] = j.driveFolderUrl as string;

    // 文字起こし
    if (j.transcriptDone) {
      out("  文字起こしは保存済みです");
    } else if (z.transcript) {
      await putSmallFile(wsToken, `${when.date}_${title}.vtt`, j.driveFolderId as string, "text/vtt", z.transcript);
      j.transcriptDone = true;
      await saveJob(env, j);
      out(`  文字起こしを保存した（${z.transcript.length} 文字）`);
    } else {
      j.transcriptDone = true;
      await saveJob(env, j);
      out("  文字起こしは Zoom 側にありません");
    }

    // 動画をドライブへ
    if (j.driveDone) {
      out("  動画はドライブへ保存済みです");
    } else {
      out("  動画をドライブへ");
      await sendVideo(
        z,
        size,
        wsToken,
        () =>
          openSession(
            wsToken,
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id",
            { name: `${when.date}_${title}.mp4`, parents: [j.driveFolderId] },
            size,
            "video/mp4",
          ),
        j.driveSession,
        async (session) => {
          j.driveSession = session;
          await saveJob(env, j);
        },
        out,
        beat,
      );
      j.driveDone = true;
      await saveJob(env, j);
    }
    await set("Drive保存済み");

    // 動画を YouTube へ
    if (j.youtubeUrl) {
      out("  YouTube には上げ済みです");
    } else {
      out("  動画を YouTube へ（限定公開で依頼）");
      await set("YouTube投稿中");
      const yt = await accessToken(env, "youtube");
      if (!yt.ok) throw new Error(yt.why);

      const video = (await sendVideo(
        z,
        size,
        yt.token,
        () =>
          openSession(
            yt.token,
            "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
            {
              snippet: { title: (row[COL.title] || z.topic || "無題").slice(0, 100), description: "" },
              /**
               * 2026-08-20：この チャンネル では、上げたあと手で 限定公開 に変えても
               * 非公開に戻されないことを実物で確認した（固定は掛かっていない）。
               * そこで最初から 限定公開 で頼む。
               */
              status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
            },
            size,
            "video/mp4",
          ),
        j.ytSession,
        async (session) => {
          j.ytSession = session;
          await saveJob(env, j);
        },
        out,
        beat,
      )) as { id?: string; status?: { privacyStatus?: string } };

      if (!video.id) throw new Error("YouTube が動画の番号を返しません");
      j.youtubeId = video.id;
      j.youtubeUrl = `https://www.youtube.com/watch?v=${video.id}`;
      j.privacy = video.status?.privacyStatus ?? "不明";
      await saveJob(env, j);
    }

    row[COL.youtube] = j.youtubeUrl as string;
    const privacy = j.privacy ?? "不明";
    const jp = privacy === "unlisted" ? "限定公開" : privacy === "private" ? "非公開" : privacy;
    out(`  YouTube 側の公開設定：${jp}`);

    // 限定公開で頼んだのに非公開になった場合は、Naoki が手で直せるように印を残す
    await set("完了", jp === "限定公開" ? "" : `YouTube 側で ${jp} になりました。手で 限定公開 に変えてください`);
    out(`  完了：${row[COL.youtube]}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    out(`  エラー：${why}`);
    try {
      await set("エラー", why.slice(0, 900));
    } catch {
      out("  シートへの書き戻しにも失敗しました");
    }
  }
}

async function runAll(env: Env, out: (s: string) => void, beat: () => Promise<void>): Promise<void> {
  const started = Date.now();

  const ws = await accessToken(env, "workspace");
  if (!ws.ok) {
    out(`止まりました：${ws.why}`);
    return;
  }
  const sid = await sheetId(env);
  if (!sid) {
    out("シートがまだありません。/setup/sheet を開いて作ってください。");
    return;
  }

  /**
   * 錠を取れた実行から見ると、他の実行は走っていない。
   * だから「処理の途中」の状態のまま残っている行は、必ず前の実行が落ちた残り。
   */
  const rows = await readRows(ws.token, sid);
  const targets: { no: number; row: string[]; why: string }[] = [];
  rows.forEach((row, i) => {
    const share = (row[COL.share] ?? "").trim();
    const state = (row[COL.state] ?? "").trim();
    if (!share) return;
    if (state === "" || state === "未処理") targets.push({ no: i + 2, row, why: "未処理" });
    else if (state === "エラー") targets.push({ no: i + 2, row, why: "前のエラーからやり直し" });
    else if (MIDWAY.includes(state)) targets.push({ no: i + 2, row, why: `${state} のまま止まっていた続き` });
  });

  out(`通す行：${targets.length} 件`);
  out("");

  for (const t of targets) {
    if (Date.now() - started > RUN_BUDGET_MS) {
      out(`ここで一度畳みます（${sec(Date.now() - started)} 秒）。残りは次の自動実行が続けます。`);
      return;
    }
    out(`（${t.why}）`);
    await processRow(env, ws.token, sid, t.no, t.row, out, beat);
    out("");
  }
  out("ここまでです。");
}

/**
 * 同時に走らないようにする（5分ごとの自動実行と手動が重ならないため）。
 * 錠は動いている間ずっと押し直す。3分押されていなければ、前の実行は落ちたものとみなして引き取る。
 */
async function withLock(
  env: Env,
  fn: (beat: () => Promise<void>) => Promise<void>,
  out: (s: string) => void,
): Promise<void> {
  const held = await env.STORE.get(LOCK_KEY);
  if (held) {
    const at = Number(await held.text());
    if (Date.now() - at < LOCK_STALE_MS) {
      out("いま別の処理が動いています。終わるまで待ってください。");
      return;
    }
    out("前の処理が落ちたまま残っていたので、引き取ります。");
  }

  const beat = async () => {
    await env.STORE.put(LOCK_KEY, String(Date.now()));
  };

  await beat();
  try {
    await fn(beat);
  } finally {
    await env.STORE.delete(LOCK_KEY);
  }
}

/* ================================================================== */
/* 許可                                                                */
/* ================================================================== */

async function oauthStart(request: Request, env: Env): Promise<Response> {
  const missing = missingSetup(env);
  if (missing.length > 0) {
    return text(
      ["設定が足りません。Cloudflare の Settings → Variables and Secrets で Type: Secret として入れてください。", "", ...missing.map((m) => "  ・" + m)].join("\n"),
      500,
    );
  }

  const which = new URL(request.url).searchParams.get("for");
  if (!isPermitName(which)) {
    return text(
      [
        "許可は2回に分けて出します。",
        "",
        "  1本目：ドライブへ保存し、シートに書き戻す許可",
        "      ふだんの Google アカウントを選ぶ",
        `      ${new URL("/oauth/start?for=workspace", request.url).toString()}`,
        "",
        "  2本目：YouTube へ動画を上げる許可",
        "      上げ先のチャンネルのブランドアカウントを選ぶ",
        `      ${new URL("/oauth/start?for=youtube", request.url).toString()}`,
      ].join("\n"),
    );
  }

  const permit = PERMITS[which];
  const state = crypto.randomUUID();
  await env.STORE.put(`auth/state/${state}`, which);

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID as string);
  auth.searchParams.set("redirect_uri", new URL("/oauth/callback", request.url).toString());
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", permit.scopes);
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("state", state);
  return Response.redirect(auth.toString(), 302);
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return text(`Google 側で許可が出ませんでした。\n\n理由：${err}`, 400);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return text("許可の受け取りに必要な値がありません。", 400);

  const heldObj = await env.STORE.get(`auth/state/${state}`);
  const held = heldObj ? await heldObj.text() : null;
  if (!held || !isPermitName(held)) return text("合言葉が合いません。/oauth/start からやり直してください。", 400);
  await env.STORE.delete(`auth/state/${state}`);
  const permit = PERMITS[held];

  const redirectUri = new URL("/oauth/callback", request.url).toString();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok) {
    return text(
      `Google との引き換えに失敗しました。\n\n${body.error ?? res.status}／${body.error_description ?? "説明なし"}\n\n戻り先の住所：${redirectUri}`,
      400,
    );
  }
  if (!body.refresh_token) {
    return text(
      "更新用の鍵が返りませんでした。\n\nhttps://myaccount.google.com/permissions で zoom-to-youtube を取り消してから、やり直してください。",
      400,
    );
  }

  const stored: StoredAuth = {
    refresh_token: body.refresh_token,
    scope: body.scope ?? "",
    obtained_at: new Date().toISOString(),
  };
  let who: string;

  if (held === "workspace") {
    const email = (readIdToken(body.id_token ?? "").email ?? "").toLowerCase();
    if (!email || email !== (env.ALLOWED_EMAIL as string).trim().toLowerCase()) {
      return text(`このアカウントの許可は受け付けません。控えは保存していません。\n\n出したアカウント：${email || "（不明）"}`, 403);
    }
    stored.email = email;
    who = email;
  } else {
    if (!body.access_token) return text("使い捨ての鍵が返りませんでした。", 400);
    const chRes = await gFetch(body.access_token, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true");
    const raw = await chRes.text();
    let ch: { id?: string; snippet?: { title?: string } } | undefined;
    try {
      ch = (JSON.parse(raw) as { items?: { id?: string; snippet?: { title?: string } }[] }).items?.[0];
    } catch {
      /* 下で raw を出す */
    }
    if (!chRes.ok || !ch?.id) {
      return text(`どのチャンネルかを確かめられませんでした。控えは保存していません。\n\n${chRes.status}\n${raw.slice(0, 1500)}`, 400);
    }
    const prev = await env.STORE.get(permit.key);
    if (prev) {
      const before = JSON.parse(await prev.text()) as StoredAuth;
      if (before.channel_id && before.channel_id !== ch.id) {
        return text(
          `先に登録してあるチャンネルと違うため差し替えませんでした。\n\n登録済み：${before.channel_title}\n今回：${ch.snippet?.title}`,
          409,
        );
      }
    }
    stored.channel_id = ch.id;
    stored.channel_title = ch.snippet?.title ?? "";
    who = `${stored.channel_title}（${ch.id}）`;
  }

  await env.STORE.put(permit.key, JSON.stringify(stored));
  const other: PermitName = held === "youtube" ? "workspace" : "youtube";
  const otherDone = (await env.STORE.head(PERMITS[other].key)) !== null;

  return text(
    [
      `保存しました：${permit.label}`,
      "",
      `対象：${who}`,
      `保存した日時：${stored.obtained_at}`,
      "",
      otherDone
        ? "2本とも終わりました。この画面は閉じて大丈夫です。"
        : `残り1本あります。\n\n  ${PERMITS[other].label}\n      ${new URL("/oauth/start?for=" + other, request.url).toString()}`,
    ].join("\n"),
  );
}

async function oauthStatus(env: Env): Promise<Response> {
  const missing = missingSetup(env);
  const lines = ["--- 許可の状態 ---", "", `設定の3つ　${missing.length === 0 ? "そろっている" : "足りない：" + missing.join(", ")}`, ""];

  for (const which of ["workspace", "youtube"] as PermitName[]) {
    lines.push(`■ ${PERMITS[which].label}`);
    const obj = await env.STORE.get(PERMITS[which].key);
    if (!obj) {
      lines.push(`    控え　　　　まだ無い（/oauth/start?for=${which}）`);
      lines.push("");
      continue;
    }
    const saved = JSON.parse(await obj.text()) as StoredAuth;
    const days = Math.floor((Date.now() - Date.parse(saved.obtained_at)) / 86400000) + 1;
    lines.push(`    控え　　　　ある（${saved.obtained_at}・取得から ${days} 日目）`);
    lines.push(`    対象　　　　${saved.email ?? saved.channel_title ?? "（不明）"}`);
    if (missing.length === 0) {
      const t = await accessToken(env, which);
      lines.push(`    いま使えるか　${t.ok ? "使える" : "使えない：" + t.why}`);
    }
    lines.push("");
  }

  const sid = await sheetId(env);
  lines.push("■ 管理用シート");
  lines.push(sid ? `    https://docs.google.com/spreadsheets/d/${sid}/edit` : "    まだ無い（/setup/sheet で作る）");
  lines.push("");
  lines.push("この画面に鍵そのものは表示しません。");
  return text(lines.join("\n"));
}

/* ================================================================== */

function streamed(work: (out: (s: string) => void) => Promise<void>): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const out = (line: string) => {
    void writer.write(enc.encode(line + "\n"));
  };
  void (async () => {
    try {
      await work(out);
    } catch (e) {
      out("");
      out("=== 途中で止まりました ===");
      out(String(e instanceof Error ? e.message : e));
    } finally {
      await writer.close();
    }
  })();
  return new Response(readable, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return text(
          [
            "zoom-to-youtube",
            "",
            "  /setup/sheet   管理用シートを作る（すでにあれば作らない）",
            "  /run           シートの未処理の行を通す",
            "  /oauth/status  許可とシートの状態を見る",
            "  /oauth/start   許可を通す（2本）",
          ].join("\n"),
        );

      case "/oauth/start":
        return oauthStart(request, env);
      case "/oauth/callback":
        return oauthCallback(request, env);
      case "/oauth/status":
        return oauthStatus(env);

      case "/setup/sheet": {
        const ws = await accessToken(env, "workspace");
        if (!ws.ok) return text(`できません：${ws.why}`, 400);
        const s = await makeSheet(env, ws.token);
        return text(
          [
            s.made ? "管理用シートを作りました。" : "管理用シートはすでにあります。",
            "",
            s.url,
            "",
            "使い方：2列目の Zoom共有URL と 3列目の 講義タイトル だけ入れてください。",
            "残りは自動で入ります。5分ごとに見に行きます。",
          ].join("\n"),
        );
      }

      case "/run":
        return streamed((out) => withLock(env, (beat) => runAll(env, out, beat), out));

      default:
        return text("見つかりません", 404);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const log: string[] = [];
    ctx.waitUntil(
      withLock(env, (beat) => runAll(env, (line) => log.push(line), beat), (line) => log.push(line)).then(() =>
        console.log(log.join("\n")),
      ),
    );
  },
};
