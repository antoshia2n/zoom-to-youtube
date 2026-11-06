/**
 * zoom-to-youtube / upload.ts（第32版・2026-11-06 開発部・便 C「手で上げる」）
 *
 * Zoom 以外の動画・音声（スマホで撮ったもの・ほかで録ったもの）を、マーケくんの「録画」から R2 へ入れ、
 * Zoom の録画と同じ棚に「アップロード」として並べる。作る前の 1 枚に Naoki OK（2026-11-06 19:47）。
 *
 * 流れ（ブラウザ → マーケくん → 結び ArchiveApi → R2）
 *   upload_start     控えを作り、R2 の小分けアップロードを始める。同じファイル（名前・大きさ・収録日）の書きかけがあれば、それを返す（続きから送れる）
 *   upload_part      1 片（PART_SIZE ずつ・最後だけ短い）を R2 へ。受けた片は控えに残す
 *   upload_complete  全部そろったら R2 で 1 本にまとめ、棚の元を作り直す
 *   upload_abort     やめる（R2 の書きかけも捨てる）
 *
 * 決め
 *   ・置き場は upload/files/<番号>/<file>.<拡張子>。控えは upload/rec/<番号>.json
 *   ・1 片は 16MB（R2 は最後以外の片を同じ大きさにし、5MB 以上にする決まり。マーケくんの 1 回に送れる量より十分小さく）
 *   ・受けるのは動画（mp4・mov・m4v・webm）と音声（m4a・mp3・wav）。4GB まで
 *   ・文字起こしは付けない（付けるかはあとで決める・作る前の 1 枚）。YouTube にも上げない
 *   ・48 時間動きの無い書きかけは、次に upload_start が呼ばれたときに捨てる
 */
/** share.ts の readJson と同じ（share.ts がこのファイルを読むので、輪にならないよう写した） */
async function readJson<T>(store: R2Bucket, key: string): Promise<T | null> {
  const o = await store.get(key);
  if (!o) return null;
  try {
    return JSON.parse(await o.text()) as T;
  } catch {
    return null;
  }
}

export interface UploadEnv {
  STORE: R2Bucket;
}

export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const STALE_MS = 48 * 3600 * 1000;

export const UPLOAD_TYPES: Record<string, { mime: string; video: boolean }> = {
  mp4: { mime: "video/mp4", video: true },
  m4v: { mime: "video/mp4", video: true },
  mov: { mime: "video/quicktime", video: true },
  webm: { mime: "video/webm", video: true },
  m4a: { mime: "audio/mp4", video: false },
  mp3: { mime: "audio/mpeg", video: false },
  wav: { mime: "audio/wav", video: false },
};

export interface UploadRec {
  id: string;
  date: string;
  title: string;
  kai: string;
  labels?: string[];
  fileName: string;
  ext: string;
  mime: string;
  video: boolean;
  size: number;
  r2Key: string;
  r2UploadId: string;
  parts: { partNumber: number; etag: string }[];
  state: "uploading" | "done";
  by?: string;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
}

export const uploadRecKey = (id: string) => `upload/rec/${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;

const KAIS = ["セミナー", "打ち合わせ", "個別相談", "Zoom添削", "その他"];

function newId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return "up_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function partsTotal(size: number): number {
  return Math.max(1, Math.ceil(size / PART_SIZE));
}

/** 書きかけ・済みの控えを全部読む（棚の元を作るときにも使う） */
export async function listUploads(store: R2Bucket): Promise<UploadRec[]> {
  const out: UploadRec[] = [];
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await store.list({ prefix: "upload/rec/", cursor });
    const got = await Promise.all(page.objects.map((o) => readJson<UploadRec>(store, o.key)));
    for (const r of got) if (r) out.push(r);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}

function view(r: UploadRec) {
  const total = partsTotal(r.size);
  return {
    id: r.id,
    state: r.state,
    file_name: r.fileName,
    size: r.size,
    part_size: PART_SIZE,
    parts_total: total,
    parts_done: r.parts.map((p) => p.partNumber).sort((a, b) => a - b),
  };
}

export async function uploadStart(
  env: UploadEnv,
  b: { file_name?: string; size?: number; date?: string; title?: string; kai?: string; labels?: string[]; by?: string },
): Promise<object> {
  const fileName = String(b?.file_name ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  const ext = (fileName.match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? "").toLowerCase();
  const t = UPLOAD_TYPES[ext];
  if (!t) return { ok: false, error: "bad_type", note: "受けられるのは mp4・mov・m4v・webm・m4a・mp3・wav" };
  const size = Math.floor(Number(b?.size));
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "bad_size" };
  if (size > MAX_BYTES) return { ok: false, error: "too_big", note: "4GB まで" };
  const date = String(b?.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "bad_date", field: "date", note: "収録日は YYYY-MM-DD" };
  const kai = KAIS.includes(String(b?.kai)) ? String(b?.kai) : "その他";
  const title = String(b?.title ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || fileName.replace(/\.[^.]+$/, "");
  const labels = (Array.isArray(b?.labels) ? b.labels : []).map((x) => String(x ?? "").normalize("NFKC").trim().slice(0, 30)).filter(Boolean).slice(0, 20);

  const all = await listUploads(env.STORE);
  const now = Date.now();
  // 動きの無い書きかけを捨てる
  for (const r of all) {
    if (r.state !== "uploading" || now - Date.parse(r.updatedAt) < STALE_MS) continue;
    try {
      await env.STORE.resumeMultipartUpload(r.r2Key, r.r2UploadId).abort();
    } catch {
      /* もう無い */
    }
    await env.STORE.delete(uploadRecKey(r.id));
  }
  // 同じファイルの書きかけがあれば続きから
  const same = all.find((r) => r.state === "uploading" && r.fileName === fileName && r.size === size && r.date === date && now - Date.parse(r.updatedAt) < STALE_MS);
  if (same) {
    same.title = title;
    same.kai = kai;
    same.labels = labels.length ? labels : undefined;
    same.updatedAt = new Date().toISOString();
    await env.STORE.put(uploadRecKey(same.id), JSON.stringify(same));
    return { ok: true, resumed: true, ...view(same) };
  }

  const id = newId();
  const [y, m] = date.split("-");
  const r2Key = `upload/files/${y}/${m}/${id}.${ext}`;
  const mp = await env.STORE.createMultipartUpload(r2Key, { httpMetadata: { contentType: t.mime } });
  const rec: UploadRec = {
    id,
    date,
    title,
    kai,
    labels: labels.length ? labels : undefined,
    fileName,
    ext,
    mime: t.mime,
    video: t.video,
    size,
    r2Key,
    r2UploadId: mp.uploadId,
    parts: [],
    state: "uploading",
    by: b?.by ? String(b.by).slice(0, 120) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await env.STORE.put(uploadRecKey(id), JSON.stringify(rec));
  return { ok: true, resumed: false, ...view(rec) };
}

/** 1 片を受ける。body は 1 片の中身（ReadableStream か ArrayBuffer） */
export async function uploadPart(env: UploadEnv, id: string, partNumber: number, body: ReadableStream | ArrayBuffer | null): Promise<object> {
  const rec = await readJson<UploadRec>(env.STORE, uploadRecKey(String(id ?? "")));
  if (!rec) return { ok: false, error: "not_found" };
  if (rec.state !== "uploading") return { ok: false, error: "already_done" };
  const total = partsTotal(rec.size);
  const n = Math.floor(Number(partNumber));
  if (!Number.isFinite(n) || n < 1 || n > total) return { ok: false, error: "bad_part", note: `片の番号は 1〜${total}` };
  if (!body) return { ok: false, error: "no_body" };
  const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
  const want = n < total ? PART_SIZE : rec.size - PART_SIZE * (total - 1);
  if (buf.byteLength !== want) return { ok: false, error: "bad_length", note: `この片は ${want} バイトのはず（届いたのは ${buf.byteLength}）` };
  const up = env.STORE.resumeMultipartUpload(rec.r2Key, rec.r2UploadId);
  let part: R2UploadedPart;
  try {
    part = await up.uploadPart(n, buf);
  } catch (e) {
    return { ok: false, error: "r2_failed", message: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
  // 読み直してから足す（別の片が同時に書いていても消さない）
  const cur = (await readJson<UploadRec>(env.STORE, uploadRecKey(rec.id))) ?? rec;
  cur.parts = [...cur.parts.filter((p) => p.partNumber !== n), { partNumber: n, etag: part.etag }];
  cur.updatedAt = new Date().toISOString();
  await env.STORE.put(uploadRecKey(rec.id), JSON.stringify(cur));
  return { ok: true, part: n, parts_done: cur.parts.length, parts_total: total };
}

export async function uploadComplete(env: UploadEnv, id: string): Promise<object> {
  const rec = await readJson<UploadRec>(env.STORE, uploadRecKey(String(id ?? "")));
  if (!rec) return { ok: false, error: "not_found" };
  if (rec.state === "done") return { ok: true, id: rec.id, already: true };
  const total = partsTotal(rec.size);
  const have = new Set(rec.parts.map((p) => p.partNumber));
  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!have.has(i)) missing.push(i);
  if (missing.length) return { ok: false, error: "missing_parts", missing: missing.slice(0, 50), parts_total: total };
  const up = env.STORE.resumeMultipartUpload(rec.r2Key, rec.r2UploadId);
  try {
    await up.complete([...rec.parts].sort((a, b) => a.partNumber - b.partNumber));
  } catch (e) {
    return { ok: false, error: "r2_failed", message: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
  const head = await env.STORE.head(rec.r2Key);
  if (!head || head.size !== rec.size) return { ok: false, error: "size_mismatch", note: `R2 に入った大きさ ${head?.size ?? 0} が ${rec.size} と違う` };
  rec.state = "done";
  rec.doneAt = new Date().toISOString();
  rec.updatedAt = rec.doneAt;
  await env.STORE.put(uploadRecKey(rec.id), JSON.stringify(rec));
  return { ok: true, id: rec.id, size: head.size };
}

export async function uploadAbort(env: UploadEnv, id: string): Promise<object> {
  const rec = await readJson<UploadRec>(env.STORE, uploadRecKey(String(id ?? "")));
  if (!rec) return { ok: false, error: "not_found" };
  if (rec.state === "done") return { ok: false, error: "already_done", note: "入れ終わった録画は zoom_archive__delete で消す" };
  try {
    await env.STORE.resumeMultipartUpload(rec.r2Key, rec.r2UploadId).abort();
  } catch {
    /* もう無い */
  }
  await env.STORE.delete(uploadRecKey(rec.id));
  return { ok: true, id: rec.id };
}
