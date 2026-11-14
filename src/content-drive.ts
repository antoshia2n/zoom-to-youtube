/**
 * 第27版（2026-11-12 開発部）：コンテンツくんの依頼で GPT が作った画像を、Naoki のドライブへ写す。
 *
 * Naoki「その記事に紐づいたデータは『日付＋記事』→『引用図解』『サムネ』『記事内図解』みたいなフォルダ構成で
 * X からアクセスできるような形だと助かる」（2026-11-12 12:08）。
 *
 * 置き方：
 *   コンテンツくん/2026-11/2026-11-14_題/引用図解/01.png 02.png …
 *
 * - 書く許可は、録画をドライブへ置くのと同じ「ふだんの Google アカウント」の許可（auth/workspace.json）。
 *   各アプリ共通のサービスアカウントは個人のドライブにファイルを置けない（Google の仕様）ため使わない。
 * - drive.file の許可なので、見えるのはこの仕組みが作ったフォルダとファイルだけ。Naoki が手で作った同名のフォルダは使わない。
 * - 記事ごとのフォルダの番号は R2（content-drive/posts/<投稿の番号>.json）に残す。
 *   題や日付が変わったら、次に画像が入ったときにフォルダの名前と月を付け直す。
 * - 元の画像は呼ぶ側（shia2n-mcp）が渡す https の住所（Supabase の公開の置き場）から読む。
 */

const ROOT_NAME = "コンテンツくん";
const ROOT_KEY = "content-drive/root.json";
const postKey = (postId: string) => `content-drive/posts/${postId.replace(/[^0-9A-Za-z_-]/g, "")}.json`;
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface ContentDriveEnv {
  STORE: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface SaveContentImagesInput {
  /** コンテンツくんの投稿の番号（フォルダを覚えておく鍵） */
  post_id: string | number;
  /** 投稿の題 */
  title: string;
  /** 投稿の予定日（YYYY-MM-DD…）。無ければ「日付なし」 */
  date?: string | null;
  /** 中のフォルダの名前（引用図解・サムネ・記事内図解） */
  sub: string;
  /** 画像。並びの順に 01・02… の名前で置く */
  images: { url: string; mime?: string }[];
}

export type SaveContentImagesResult =
  | { ok: true; folder_url: string; path: string; saved: number; failed: number }
  | { ok: false; error: string };

const safe = (s: string, n = 60) =>
  String(s || "").replace(/[\\/:*?"<>|\n\r\t]/g, "").replace(/\s+/g, " ").trim().slice(0, n) || "無題";

export async function token(env: ContentDriveEnv): Promise<string> {
  const obj = await env.STORE.get("auth/workspace.json");
  if (!obj) throw new Error("ドライブへ保存する許可の控えがありません（/oauth/start から通す）");
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
  const b = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !b.access_token) {
    throw new Error(`ドライブの許可が使えません（${b.error ?? res.status}）${b.error === "invalid_grant" ? "。/oauth/start から通し直す" : ""}`);
  }
  return b.access_token;
}

export async function g<T>(tk: string, url: string, init: RequestInit = {}): Promise<T> {
  const h = new Headers(init.headers);
  h.set("authorization", `Bearer ${tk}`);
  const res = await fetch(url, { ...init, headers: h });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google ${res.status}：${raw.slice(0, 300)}`);
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

const qs = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function findOrMakeFolder(tk: string, name: string, parent: string | null): Promise<string> {
  const q = [`name = '${qs(name)}'`, `mimeType = '${FOLDER_MIME}'`, "trashed = false", parent ? `'${parent}' in parents` : "'root' in parents"].join(" and ");
  const found = await g<{ files?: { id: string }[] }>(tk, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  if (found.files?.[0]) return found.files[0].id;
  const made = await g<{ id: string }>(tk, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined }),
  });
  return made.id;
}

/** まだ生きているフォルダか（ゴミ箱に入れられていないか） */
async function alive(tk: string, id: string): Promise<{ name: string; parents: string[] } | null> {
  try {
    const f = await g<{ name: string; parents?: string[]; trashed?: boolean }>(tk, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,parents,trashed`);
    return f.trashed ? null : { name: f.name, parents: f.parents ?? [] };
  } catch {
    return null;
  }
}

async function rootFolder(env: ContentDriveEnv, tk: string): Promise<string> {
  const o = await env.STORE.get(ROOT_KEY);
  if (o) {
    const { id } = JSON.parse(await o.text()) as { id: string };
    if (await alive(tk, id)) return id;
  }
  const id = await findOrMakeFolder(tk, ROOT_NAME, null);
  await env.STORE.put(ROOT_KEY, JSON.stringify({ id }));
  return id;
}

/** 記事のフォルダ。前に作ったものがあれば、名前と月を今の題・日付に付け直して使う */
async function postFolder(env: ContentDriveEnv, tk: string, root: string, postId: string, month: string, name: string): Promise<string> {
  const monthId = await findOrMakeFolder(tk, month, root);
  const o = await env.STORE.get(postKey(postId));
  if (o) {
    const { id } = JSON.parse(await o.text()) as { id: string };
    const cur = await alive(tk, id);
    if (cur) {
      const moveTo = cur.parents.includes(monthId) ? "" : `&addParents=${monthId}&removeParents=${cur.parents.join(",")}`;
      if (cur.name !== name || moveTo) {
        await g(tk, `https://www.googleapis.com/drive/v3/files/${id}?fields=id${moveTo}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      }
      return id;
    }
  }
  const id = await findOrMakeFolder(tk, name, monthId);
  await env.STORE.put(postKey(postId), JSON.stringify({ id, at: new Date().toISOString() }));
  return id;
}

async function upsertFile(tk: string, parent: string, name: string, existing: Map<string, string>, data: ArrayBuffer, mime: string): Promise<void> {
  const id = existing.get(name);
  if (id) {
    await g(tk, `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id`, {
      method: "PATCH",
      headers: { "content-type": mime },
      body: data,
    });
    return;
  }
  const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + data.byteLength + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(data), head.length);
  body.set(tail, head.length + data.byteLength);
  await g(tk, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

const extOf = (url: string, mime: string) => {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url);
  return (m ? m[1] : (mime.split("/")[1] || "png")).toLowerCase().replace("jpeg", "jpg");
};

export async function saveContentImages(env: ContentDriveEnv, input: SaveContentImagesInput): Promise<SaveContentImagesResult> {
  try {
    const postId = String(input.post_id ?? "").trim();
    if (!postId) return { ok: false, error: "post_id が空です" };
    const imgs = (input.images || []).filter((i) => /^https:\/\//.test(i.url)).slice(0, 12);
    if (!imgs.length) return { ok: false, error: "置く画像がありません" };
    const date = /^\d{4}-\d{2}-\d{2}/.test(input.date || "") ? String(input.date).slice(0, 10) : "";
    const month = date ? date.slice(0, 7) : "日付なし";
    const name = `${date || "日付なし"}_${safe(input.title)}`;
    const sub = safe(input.sub, 20);

    const tk = await token(env);
    const root = await rootFolder(env, tk);
    const pf = await postFolder(env, tk, root, postId, month, name);
    const sf = await findOrMakeFolder(tk, sub, pf);

    const list = await g<{ files?: { id: string; name: string }[] }>(
      tk,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${sf}' in parents and trashed = false`)}&fields=files(id,name)&pageSize=100`,
    );
    const existing = new Map((list.files ?? []).map((f) => [f.name, f.id] as [string, string]));

    let saved = 0, failed = 0;
    const keep = new Set<string>();
    for (let i = 0; i < imgs.length; i++) {
      try {
        const res = await fetch(imgs[i].url);
        if (!res.ok) throw new Error(String(res.status));
        const mime = imgs[i].mime || res.headers.get("content-type") || "image/png";
        const fname = `${String(i + 1).padStart(2, "0")}.${extOf(imgs[i].url, mime)}`;
        keep.add(fname);
        await upsertFile(tk, sf, fname, existing, await res.arrayBuffer(), mime);
        saved++;
      } catch {
        failed++;
      }
    }
    // 入れ直しで枚数が減ったときの残り（この仕組みが前に置いた番号の画像だけ）はゴミ箱へ
    for (const [fname, id] of existing) {
      if (!keep.has(fname) && /^\d{2}\.[a-z0-9]+$/.test(fname)) {
        await g(tk, `https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trashed: true }),
        }).catch(() => {});
      }
    }
    return { ok: true, folder_url: `https://drive.google.com/drive/folders/${pf}`, path: `${ROOT_NAME}/${month}/${name}/${sub}`, saved, failed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
