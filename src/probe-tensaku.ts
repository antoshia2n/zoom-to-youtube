/**
 * 添削の試し（2026-09-25 開発部・一時的なもの）
 *
 * 目的：Naoki 本人の資格（許可の組 workspace・範囲は drive.file）だけで、
 *   ① Google ドキュメントを 1 冊作れるか
 *   ② その中にタブを足せるか
 *   ③ タブの中へ文を書けるか
 *   ④ 文の範囲を指してコメントを付けられるか
 *   ⑤ 書いたものを読み戻せるか
 * を実物で確かめる。依頼書：https://app.notion.com/p/3e69c6c1c43981bd8495e83a10b48a16
 *
 * 作るのは 1 冊だけ。2 回目以降は作らず、1 回目の結果をそのまま返す（控えの鍵 PROBE_KEY）。
 * ファイルは消さない。確かめ終わったら、この口ごと外す。
 */

const PROBE_KEY = "probe/tensaku-2026-09-25.json";
const DOCS = "https://docs.googleapis.com/v1/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

type Step = { name: string; ok: boolean; status?: number; detail: string };

async function call(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: any; raw: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers });
  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, raw: raw.slice(0, 500) };
}

export async function probeTensaku(
  store: R2Bucket,
  getToken: () => Promise<{ ok: true; token: string } | { ok: false; why: string }>,
): Promise<string> {
  const done = await store.get(PROBE_KEY);
  if (done) return "（2 回目以降なので作らず、1 回目の結果を返します）\n\n" + (await done.text());

  const t = await getToken();
  if (!t.ok) return `できません：${t.why}`;
  const token = t.token;
  const steps: Step[] = [];
  const stamp = new Date().toISOString();

  // ① 1 冊作る
  const made = await call(token, DOCS, {
    method: "POST",
    body: JSON.stringify({ title: `添削の試し ${stamp}` }),
  });
  const docId: string | undefined = made.body?.documentId;
  steps.push({
    name: "1 冊作る",
    ok: made.ok && !!docId,
    status: made.status,
    detail: docId ? `https://docs.google.com/document/d/${docId}/edit` : made.raw,
  });
  if (!docId) return finish(store, steps);

  // ② タブを足す
  const tab = await call(token, `${DOCS}/${docId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addDocumentTab: { tabProperties: { title: "添削 1 回目" } } }] }),
  });
  const tabId: string | undefined = tab.body?.replies?.[0]?.addDocumentTab?.tabProperties?.tabId;
  steps.push({ name: "タブを足す", ok: tab.ok && !!tabId, status: tab.status, detail: tabId ? `tabId=${tabId}` : tab.raw });

  // ③ タブの中へ文を書く（タブが無ければ最初の本文へ書く）
  const sentence = "これは添削の試しの文です。ここを指してコメントを付けます。";
  const location: Record<string, unknown> = { index: 1 };
  if (tabId) location.tabId = tabId;
  const ins = await call(token, `${DOCS}/${docId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: [{ insertText: { location, text: sentence } }] }),
  });
  steps.push({
    name: tabId ? "タブの中へ文を書く" : "本文へ文を書く（タブが無いため）",
    ok: ins.ok,
    status: ins.status,
    detail: ins.ok ? "書けた" : ins.raw,
  });

  // ③' 指したい範囲に色を付ける（コメントが範囲に付かなかったときの代わりの手）
  const target = "ここを指して";
  const start = 1 + sentence.indexOf(target);
  const range: Record<string, unknown> = { startIndex: start, endIndex: start + target.length };
  if (tabId) range.tabId = tabId;
  const hl = await call(token, `${DOCS}/${docId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          updateTextStyle: {
            range,
            textStyle: { backgroundColor: { color: { rgbColor: { red: 1, green: 0.95, blue: 0.6 } } } },
            fields: "backgroundColor",
          },
        },
      ],
    }),
  });
  steps.push({ name: "範囲に色を付ける", ok: hl.ok, status: hl.status, detail: hl.ok ? "付けた" : hl.raw });

  // ④ 範囲を指してコメントを付ける
  const cm = await call(token, `${DRIVE}/${docId}/comments?fields=id,content,anchor,quotedFileContent`, {
    method: "POST",
    body: JSON.stringify({
      content: "添削の試しのコメントです。",
      quotedFileContent: { mimeType: "text/plain", value: target },
    }),
  });
  steps.push({
    name: "範囲を指してコメントを付ける",
    ok: cm.ok,
    status: cm.status,
    detail: cm.ok ? `id=${cm.body?.id}・anchor=${cm.body?.anchor ?? "無し"}` : cm.raw,
  });

  // ⑤ 読み戻す（タブごと）
  const back = await call(token, `${DOCS}/${docId}?includeTabsContent=true`);
  const tabs: any[] = back.body?.tabs ?? [];
  const titles = tabs.map((x) => x?.tabProperties?.title ?? "?").join("・");
  const allText = JSON.stringify(back.body ?? {});
  steps.push({
    name: "タブごと読み戻す",
    ok: back.ok && allText.includes("ここを指して"),
    status: back.status,
    detail: back.ok ? `タブ ${tabs.length} 本（${titles}）・書いた文が ${allText.includes("ここを指して") ? "見える" : "見えない"}` : back.raw,
  });

  const cl = await call(token, `${DRIVE}/${docId}/comments?fields=comments(id,content,quotedFileContent,anchor)`);
  const n = cl.body?.comments?.length ?? 0;
  steps.push({ name: "コメントを読み戻す", ok: cl.ok && n > 0, status: cl.status, detail: cl.ok ? `${n} 件` : cl.raw });

  return finish(store, steps);
}

async function finish(store: R2Bucket, steps: Step[]): Promise<string> {
  const lines = [
    "--- 添削の試し（drive.file の範囲だけで届くか）---",
    "",
    ...steps.map((s) => `${s.ok ? "○" : "×"} ${s.name}（${s.status ?? "-"}）　${s.detail}`),
    "",
    "コメントが文の範囲に付いて見えるかは、上の 1 冊を開いて目で確かめる（Google の口の返事だけでは分からない）。",
  ];
  const out = lines.join("\n");
  await store.put(PROBE_KEY, out);
  return out;
}
