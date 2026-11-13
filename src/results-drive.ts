/**
 * 第35版（2026-11-13 開発部・実績の便 2）：Google ドライブの「実績の受け箱」フォルダに入れたスクショを、マーケくんの「実績」へ渡す。
 *
 * Naoki「基本的には AI やドライブとかにスクショとかアップしたら自動で仕分けて欲しい」（2026-11-13 16:43）。
 *
 * - フォルダはこの仕組みが作る：マイドライブ直下の「実績の受け箱」。番号は R2（results-drive/folder.json）
 * - Naoki が手で入れたファイルを読むには drive.readonly の許可が要る（drive.file では、この仕組みが作ったものしか見えない）。
 *   許可は「ふだんの Google アカウント」（auth/workspace.json）に足し、/oauth/start?for=workspace で 1 回出し直す。
 *   読むだけの許可なので、ドライブのファイルは動かさず・消さない。取り込んだファイルの番号を R2（results-drive/done/<番号>）に覚えて 2 回目は渡さない
 * - 渡すのは画像（png・jpeg・webp・gif）と PDF、20MB まで。呼ぶ側（マーケくんの 5 分ごとの処理）が R2 に置き、AI に仕分けさせてから done を呼ぶ
 */

const FOLDER_NAME = "実績の受け箱";
const FOLDER_KEY = "results-drive/folder.json";
const doneKey = (id: string) => `results-drive/done/${id.replace(/[^0-9A-Za-z_-]/g, "")}`;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];
const MAX_BYTES = 20 * 1024 * 1024;

export interface ResultsDriveEnv {
  STORE: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface InboxFile {
  file_id: string;
  name: string;
  mime: string;
  size: number;
  created: string;
  data: ArrayBuffer;
}

async function token(env: ResultsDriveEnv): Promise<{ tk: string; scope: string }> {
  const obj = await env.STORE.get("auth/workspace.json");
  if (!obj) throw Object.assign(new Error("ドライブの許可の控えがありません"), { code: "need_permit" });
  const saved = JSON.parse(await obj.text()) as { refresh_token: string };
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
  const b = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!res.ok || !b.access_token) throw Object.assign(new Error(`ドライブの許可が使えません（${b.error ?? res.status}）`), { code: "need_permit" });
  return { tk: b.access_token, scope: String(b.scope || "") };
}

async function g<T>(tk: string, url: string, init: RequestInit = {}): Promise<T> {
  const h = new Headers(init.headers);
  h.set("authorization", `Bearer ${tk}`);
  const res = await fetch(url, { ...init, headers: h });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google ${res.status}：${raw.slice(0, 300)}`);
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

async function folder(env: ResultsDriveEnv, tk: string): Promise<string> {
  const o = await env.STORE.get(FOLDER_KEY);
  if (o) {
    const { id } = JSON.parse(await o.text()) as { id: string };
    try {
      const f = await g<{ trashed?: boolean }>(tk, `https://www.googleapis.com/drive/v3/files/${id}?fields=trashed`);
      if (!f.trashed) return id;
    } catch { /* 消されていたら作り直す */ }
  }
  const q = [`name = '${FOLDER_NAME}'`, `mimeType = '${FOLDER_MIME}'`, "trashed = false", "'root' in parents"].join(" and ");
  const found = await g<{ files?: { id: string }[] }>(tk, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  const id = found.files?.[0]?.id ?? (await g<{ id: string }>(tk, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  })).id;
  await env.STORE.put(FOLDER_KEY, JSON.stringify({ id, at: new Date().toISOString() }));
  return id;
}

/** 受け箱の様子：許可があるか・フォルダの住所・まだ取り込んでいない数 */
export async function inboxStatus(env: ResultsDriveEnv): Promise<object> {
  try {
    const { tk, scope } = await token(env);
    const id = await folder(env, tk);
    const url = `https://drive.google.com/drive/folders/${id}`;
    if (!scope.split(" ").includes(READ_SCOPE)) return { ok: true, permitted: false, folder_url: url, waiting: null };
    const files = await list(tk, id);
    let waiting = 0;
    for (const f of files) if (!(await env.STORE.head(doneKey(f.id)))) waiting++;
    return { ok: true, permitted: true, folder_url: url, waiting };
  } catch (e) {
    return { ok: false, error: (e as { code?: string }).code || "drive_failed", message: String((e as Error).message || e).slice(0, 300) };
  }
}

async function list(tk: string, folderId: string): Promise<{ id: string; name: string; mimeType: string; size?: string; createdTime: string }[]> {
  const q = [`'${folderId}' in parents`, "trashed = false", `(${MIMES.map((m) => `mimeType = '${m}'`).join(" or ")})`].join(" and ");
  const r = await g<{ files?: { id: string; name: string; mimeType: string; size?: string; createdTime: string }[] }>(
    tk,
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,createdTime)&orderBy=createdTime&pageSize=200`,
  );
  return r.files ?? [];
}

/** まだ取り込んでいないファイルを古い順に limit 個まで、中身ごと渡す（20MB を超えるものは渡さず覚える） */
export async function inboxTake(env: ResultsDriveEnv, limit = 5): Promise<object> {
  let tk: string, scope: string;
  try { ({ tk, scope } = await token(env)); } catch (e) { return { ok: false, error: "need_permit", message: String((e as Error).message) }; }
  if (!scope.split(" ").includes(READ_SCOPE)) return { ok: false, error: "need_permit", message: "drive.readonly の許可が無い（/oauth/start?for=workspace を通し直す）" };
  const id = await folder(env, tk);
  const out: InboxFile[] = [];
  const skipped: string[] = [];
  for (const f of await list(tk, id)) {
    if (out.length >= Math.min(Math.max(limit, 1), 10)) break;
    if (await env.STORE.head(doneKey(f.id))) continue;
    const size = Number(f.size || 0);
    if (size > MAX_BYTES) {
      await env.STORE.put(doneKey(f.id), JSON.stringify({ at: new Date().toISOString(), skipped: "too_big", name: f.name }));
      skipped.push(f.name);
      continue;
    }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { authorization: `Bearer ${tk}` } });
    if (!res.ok) continue;
    out.push({ file_id: f.id, name: f.name, mime: f.mimeType, size, created: f.createdTime, data: await res.arrayBuffer() });
  }
  return { ok: true, files: out, skipped };
}

/** 取り込み終えたファイルを覚える（次から渡さない） */
export async function inboxDone(env: ResultsDriveEnv, ids: string[]): Promise<object> {
  let n = 0;
  for (const id of (ids ?? []).slice(0, 50)) {
    if (!/^[0-9A-Za-z_-]{10,100}$/.test(String(id))) continue;
    await env.STORE.put(doneKey(String(id)), JSON.stringify({ at: new Date().toISOString() }));
    n++;
  }
  return { ok: true, done: n };
}
