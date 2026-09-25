/**
 * 添削の確定を Google へ写す口（2026-09-25 開発部・添削の段 1 の区間 3 と区間 5 の Docs 部分）
 * 依頼書：https://app.notion.com/p/3e69c6c1c43981bd8495e83a10b48a16
 *
 * ── 決まり（統括の条件）──
 *   ・指摘の正本は学ぶくん。この口は「確定」を押したときに写すだけで、何も覚えない
 *     （どの 1 冊に写したかは、返す doc_id を学ぶくんが持つ）
 *   ・Naoki 本人の資格（許可の組 workspace・drive.file）で呼ぶ。資格は画面へ渡さない
 *   ・長文の 1 冊には、原文のタブ（手を入れない）と、色と番号の印を入れる添削のタブと、指摘のタブを分けて持つ
 *   ・短文は台帳のシートに 1 行足す
 *   ・何も消さない。同じ提出を 2 回送られても、2 回目は何も作らずに前の結果を返す
 *
 * ── 呼び方 ──
 *   POST /tensaku/commit　見出し x-tensaku-key に設定の値 TENSAKU_KEY と同じ文字列
 *   本文（JSON）：
 *     submission_id  提出の番号（学ぶくん側の番号。二重防止の鍵）
 *     round          その生徒の何回目の提出か（タブの名前に使う）
 *     student_name   生徒の呼び名（冊子の題に使う）
 *     title          提出の題
 *     kind           "short" か "long"
 *     original       生徒が出した文（そのまま）
 *     revised        短文のとき：添削後の文
 *     notes          指摘の並び [{ n, start, end, text }]。start と end は original の中の位置（文字数）
 *     doc_id         長文のとき：その生徒の 1 冊がすでにあれば、その番号（無ければ作って返す）
 */

const DOCS = "https://docs.googleapis.com/v1/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const FOLDER_NAME = "しあらぼ 添削";
const LEDGER_KEY = "tensaku/short-ledger.json";
const DONE_PREFIX = "tensaku/done/";

export type Note = { n: number; start: number; end: number; text: string };
export type CommitBody = {
  submission_id: string;
  round: number;
  student_name: string;
  title: string;
  kind: "short" | "long";
  original: string;
  revised?: string;
  notes: Note[];
  doc_id?: string;
};

type TokenFn = () => Promise<{ ok: true; token: string } | { ok: false; why: string }>;

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function g(token: string, url: string, init: RequestInit = {}): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Google ${res.status}：${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : {};
}

/** 本文の形を確かめる。おかしければ理由を返す */
export function checkBody(b: any): string | null {
  if (!b || typeof b !== "object") return "本文が JSON ではない";
  if (typeof b.submission_id !== "string" || !b.submission_id) return "submission_id が無い";
  if (b.kind !== "short" && b.kind !== "long") return "kind は short か long";
  if (typeof b.original !== "string" || !b.original) return "original が無い";
  if (!Array.isArray(b.notes)) return "notes が配列ではない";
  for (const x of b.notes) {
    if (typeof x?.n !== "number" || typeof x?.text !== "string") return "notes の 1 件の形が違う（n・text）";
    // 2026-09-25 直し：短文の指摘は範囲を持たない（start・end が空で来る）。範囲を見るのは長文だけ
    if (b.kind !== "long") continue;
    if (typeof x.start !== "number" || typeof x.end !== "number") return `長文の notes の ${x.n} 番に範囲（start・end）が無い`;
    if (x.start < 0 || x.end > b.original.length || x.start >= x.end) return `notes の ${x.n} 番の範囲が original の外`;
  }
  if (b.kind === "long") {
    const sorted = [...b.notes].sort((p: Note, q: Note) => p.start - q.start);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) return "指摘の範囲が重なっている";
  }
  if (b.kind === "short" && typeof b.revised !== "string") return "短文には revised が要る";
  return null;
}

/**
 * 添削のタブに送る手順を組み立てる（テストのために外へ出してある）。
 * 範囲の後ろに「［n］」を入れ、範囲に色を付ける。後ろの指摘から順に処理するので、
 * 前の位置がずれない。Docs の位置は 1 から始まり、JavaScript の文字数と同じ数え方。
 */
export function markupRequests(tabId: string, original: string, notes: Note[]): any[] {
  const reqs: any[] = [{ insertText: { location: { index: 1, tabId }, text: original } }];
  const desc = [...notes].sort((p, q) => q.start - p.start);
  for (const x of desc) {
    reqs.push({ insertText: { location: { index: 1 + x.end, tabId }, text: `［${x.n}］` } });
    reqs.push({
      updateTextStyle: {
        range: { startIndex: 1 + x.start, endIndex: 1 + x.end, tabId },
        textStyle: { backgroundColor: { color: { rgbColor: { red: 1, green: 0.95, blue: 0.6 } } } },
        fields: "backgroundColor",
      },
    });
  }
  return reqs;
}

export function notesText(notes: Note[]): string {
  if (notes.length === 0) return "指摘はありません。\n";
  return [...notes].sort((p, q) => p.n - q.n).map((x) => `［${x.n}］${x.text}`).join("\n\n") + "\n";
}

async function folderId(token: string): Promise<string> {
  const q = [`name = '${FOLDER_NAME}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"].join(" and ");
  const found = await g(token, `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
  if (found.files?.[0]?.id) return found.files[0].id;
  const made = await g(token, `${DRIVE}?fields=id`, {
    method: "POST",
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  return made.id;
}

async function commitLong(token: string, b: CommitBody): Promise<{ doc_id: string; url: string; tabs: string[] }> {
  let docId = b.doc_id;
  if (!docId) {
    const made = await g(token, DOCS, { method: "POST", body: JSON.stringify({ title: `添削 ${b.student_name}` }) });
    docId = made.documentId as string;
    const fid = await folderId(token);
    await g(token, `${DRIVE}/${docId}?addParents=${fid}&fields=id`, { method: "PATCH", body: "{}" });
  }
  const head = `${b.round} 回目`;
  const names = [`${head} 原文`, `${head} 添削`, `${head} 指摘`];
  const add = await g(token, `${DOCS}/${docId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: names.map((title) => ({ addDocumentTab: { tabProperties: { title } } })) }),
  });
  const ids: string[] = (add.replies ?? []).map((r: any) => r?.addDocumentTab?.tabProperties?.tabId);
  if (ids.length !== 3 || ids.some((x) => !x)) throw new Error("タブを 3 つ作れなかった");
  const [origTab, markTab, noteTab] = ids;
  const requests = [
    { insertText: { location: { index: 1, tabId: origTab }, text: `${b.title}\n\n${b.original}` } },
    ...markupRequests(markTab, b.original, b.notes),
    { insertText: { location: { index: 1, tabId: noteTab }, text: notesText(b.notes) } },
  ];
  await g(token, `${DOCS}/${docId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
  return { doc_id: docId, url: `https://docs.google.com/document/d/${docId}/edit`, tabs: names };
}

async function ledgerId(store: R2Bucket, token: string): Promise<string> {
  const o = await store.get(LEDGER_KEY);
  if (o) return (JSON.parse(await o.text()) as { id: string }).id;
  const made = await g(token, SHEETS, {
    method: "POST",
    body: JSON.stringify({
      properties: { title: "しあらぼ 添削の台帳（短文）" },
      sheets: [{ properties: { title: "短文" } }],
    }),
  });
  const id = made.spreadsheetId as string;
  const fid = await folderId(token);
  await g(token, `${DRIVE}/${id}?addParents=${fid}&fields=id`, { method: "PATCH", body: "{}" });
  await g(token, `${SHEETS}/${id}/values/${encodeURIComponent("短文!A1:G1")}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [["確定日時", "提出番号", "生徒", "題", "原文", "添削後", "指摘"]] }),
  });
  await store.put(LEDGER_KEY, JSON.stringify({ id, created: new Date().toISOString() }));
  return id;
}

async function commitShort(store: R2Bucket, token: string, b: CommitBody): Promise<{ sheet_id: string; url: string }> {
  const id = await ledgerId(store, token);
  const row = [
    new Date().toISOString(),
    b.submission_id,
    b.student_name,
    b.title,
    b.original,
    b.revised ?? "",
    notesText(b.notes).trim(),
  ];
  await g(token, `${SHEETS}/${id}/values/${encodeURIComponent("短文!A:G")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [row] }),
  });
  return { sheet_id: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
}

export async function handleTensakuCommit(
  request: Request,
  env: { STORE: R2Bucket; TENSAKU_KEY?: string },
  getToken: TokenFn,
): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "POST だけ" }, 405);
  const key = (env.TENSAKU_KEY ?? "").trim();
  if (!key) return json({ ok: false, error: "設定の値 TENSAKU_KEY が入っていない" }, 503);
  if (!sameKey(request.headers.get("x-tensaku-key") ?? "", key)) return json({ ok: false, error: "鍵が違う" }, 401);

  let b: any;
  try {
    b = await request.json();
  } catch {
    return json({ ok: false, error: "本文が JSON ではない" }, 400);
  }
  const bad = checkBody(b);
  if (bad) return json({ ok: false, error: bad }, 400);

  const doneKey = DONE_PREFIX + encodeURIComponent(b.submission_id);
  const done = await env.STORE.get(doneKey);
  if (done) return json({ ok: true, again: true, ...JSON.parse(await done.text()) });

  const t = await getToken();
  if (!t.ok) return json({ ok: false, error: `Google の資格：${t.why}` }, 502);
  try {
    const out = b.kind === "long" ? await commitLong(t.token, b) : await commitShort(env.STORE, t.token, b);
    const rec = { kind: b.kind, ...out, committed_at: new Date().toISOString() };
    await env.STORE.put(doneKey, JSON.stringify(rec));
    return json({ ok: true, again: false, ...rec });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
  }
}
