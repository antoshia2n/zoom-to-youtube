/**
 * zoom-to-youtube / shelf.ts（第28版・2026-11-06 開発部・便 2「録画の棚」）
 *
 * マーケくんのシアニン用画面「録画」から結び（ArchiveApi）で呼ぶ。R2 の録画を棚に並べ、共有リンクを出す・止める・期限、
 * 名前と会の種類を整え、怪しいものを点検に集める。作る前の 1 枚とデモに Naoki OK（2026-11-06 14:21・置き場は 15:02）。
 *
 * 決め
 *   ・共有の設定（止める・期限）の正本はここ（R2 の share/t/）。管理シートの U・V は写し
 *   ・名前の正本：管理シートに行がある録画（新しい録画・台帳と結び付いた古い録画）はシートの E 列。ここでは変えない
 *     それ以外は shelf/meta/<番号>.json の上書き（無ければ名前付けの名前）
 *   ・会の種類の案（「その他」から）は AI（Workers AI）が文字起こしから出し、Naoki が承認したときだけ反映する
 *   ・消すのは今までどおり zoom_archive__delete（ここでは消さない）
 */

import { outputText, parseJson, type ArchiveEnv } from "./archive";
import { mainVideo, recKey, type LegacyRec } from "./legacy";
import {
  ensureShort,
  jKey,
  lKey,
  linkFor,
  newToken,
  readJson,
  shortHostOk,
  tKey,
  todayJst,
  type ShareRec,
} from "./share";

export const KAIS = ["セミナー", "打ち合わせ", "個別相談", "Zoom添削", "その他"] as const;
type Kai = (typeof KAIS)[number];

const metaKey = (id: string) => `shelf/meta/${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
const sugKey = (id: string) => `shelf/sug/${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
const jobKeyOf = (recId: string) => "job/" + recId.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";

interface JobLike {
  recId: string;
  date?: string;
  title?: string;
  size?: number;
  r2Key?: string;
  r2Done?: boolean;
  r2DeletedAt?: string;
  youtubeUrl?: string;
  naming?: { title?: string; kai?: string; description?: string };
}

interface Meta {
  title?: string;
  kai?: Kai;
  updatedAt: string;
}

interface Sug {
  kai: Kai | null;
  why: string;
  at: string;
}

export interface ShelfRow {
  id: string;
  kind: "new" | "legacy";
  date: string;
  title: string;
  kai: string;
  /** 管理シートに行がある（名前の正本がシートの E 列） */
  managed: boolean;
  minutes: number | null;
  size_gb: number | null;
  youtube: boolean;
  share: null | { link: string; state: "on" | "stop" | "expired"; views: number; expires: string | null; last_viewed_at: string | null };
  suggest_kai: { kai: string; why: string } | null;
  suggest_name: string | null;
  issues: string[];
}

/* ------------------------------------------------------------------ */
/* 小物                                                                */
/* ------------------------------------------------------------------ */

async function listJson<T>(store: R2Bucket, prefix: string): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await store.list({ prefix, cursor });
    await Promise.all(
      page.objects.map(async (o) => {
        const v = await readJson<T>(store, o.key);
        if (v) out.set(o.key, v);
      }),
    );
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}

/** 題名の中の日付（2026-10-28・2026/10/28・10月28日・26年10月28日・10_28）を「月-日」で。無ければ null */
export function titleMonthDay(title: string): string | null {
  const t = title.normalize("NFKC");
  let m = t.match(/(?:^|\D)(?:\d{2,4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  m = t.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  m = t.match(/^(\d{1,2})_(\d{1,2})(?:\D|$)/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  return null;
}

const CANON = /^\d{4}-\d{2}-\d{2}｜[^｜]+｜.+/;

/** 名前を「日付｜会｜話題」にそろえた案。すでにその形なら null */
export function canonicalName(date: string, kai: string, title: string): string | null {
  if (!date) return null;
  if (CANON.test(title)) {
    // 会の部分だけが違う（承認で会を変えた）ときは差し替える
    const parts = title.split("｜");
    if (parts[0] === date && parts[1] === kai) return null;
    return [date, kai, ...parts.slice(2)].join("｜");
  }
  let topic = title.normalize("NFKC").trim();
  topic = topic
    .replace(/^\d{2,4}[-/.]\d{1,2}[-/.]\d{1,2}\s*[｜|]?\s*/, "")
    .replace(/^\d{2}年\d{1,2}月\d{1,2}日\s*[｜|]?\s*/, "")
    .replace(/^\d{1,2}月\d{1,2}日\s*[｜|]?\s*/, "")
    .replace(/^\d{1,2}_\d{1,2}\s*[｜|]?\s*/, "")
    .replace(new RegExp(`^(${KAIS.join("|")})\\s*[｜|]\\s*`), "")
    .replace(/[「」『』]/g, "")
    .replace(/[｜|]/g, " ")
    .trim();
  if (!topic) topic = "録画";
  return `${date}｜${kai}｜${topic}`;
}

function shareView(rec: ShareRec | null, shortOk: boolean): ShelfRow["share"] {
  if (!rec) return null;
  const expired = !!rec.expires && todayJst() > rec.expires;
  return {
    link: linkFor(rec, shortOk),
    state: rec.stopped ? "stop" : expired ? "expired" : "on",
    views: rec.views ?? 0,
    expires: rec.expires ?? null,
    last_viewed_at: rec.lastViewedAt ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 棚の一覧                                                            */
/* ------------------------------------------------------------------ */

interface Item {
  id: string;
  kind: "new" | "legacy";
  date: string;
  baseTitle: string;
  baseKai: string;
  managed: boolean;
  minutes: number | null;
  sizeGb: number | null;
  youtube: boolean;
  /** 共有の控えを引く置き場（新しい録画は share/j/、古い録画は share/l/） */
  shareIndex: string;
  /** 結び付いた台帳の控え（古い録画のとき）。こちらに共有があればそれを使う */
  jobShareIndex?: string;
  playable: boolean;
}

const ITEMS_KEY = "shelf/items.json";
/** 控えのまとめが古くなったとみなす時間（5 分ごとの処理が作り直す。止まっていたときだけ開いた側で作り直す） */
const ITEMS_STALE_MS = 30 * 60 * 1000;

/**
 * 棚の元（録画 1 本 1 行）。控えを 520 本余り読むので 20 秒を超えることがある（中継の打ち切りに当たる）。
 * 5 分ごとの処理が shelf/items.json にまとめ、開くときはそれを 1 回読むだけにする（2026-11-06 第28版の直し）。
 */
async function items(env: ArchiveEnv, fresh = false): Promise<Item[]> {
  if (!fresh) {
    const c = await readJson<{ at: string; items: Item[] }>(env.STORE, ITEMS_KEY);
    if (c && Date.now() - Date.parse(c.at) < ITEMS_STALE_MS) return c.items;
  }
  return refreshShelfItems(env);
}

/** 控えを読み直して shelf/items.json を作り直す（5 分ごとの処理の最後に呼ぶ） */
export async function refreshShelfItems(env: ArchiveEnv): Promise<Item[]> {
  const built = await buildItems(env);
  await env.STORE.put(ITEMS_KEY, JSON.stringify({ at: new Date().toISOString(), items: built }));
  return built;
}

async function buildItems(env: ArchiveEnv): Promise<Item[]> {
  const jobs = await listJson<JobLike>(env.STORE, "job/");
  const legacy = [...(await listJson<LegacyRec>(env.STORE, "legacy/rec/")).values()];
  const covered = new Set(legacy.map((r) => r.match?.jobRecId ?? "").filter(Boolean));
  const out: Item[] = [];
  for (const [key, j] of jobs) {
    if (!j.recId) continue;
    const inR2 = !!j.r2Done && !j.r2DeletedAt;
    if (covered.has(j.recId) && !inR2) continue; // 古い録画の行 1 本にまとめる（一覧と同じ）
    if (!inR2) continue;
    out.push({
      id: j.recId,
      kind: "new",
      date: j.date ?? "",
      baseTitle: j.naming?.title ?? j.title ?? "",
      baseKai: j.naming?.kai ?? "その他",
      managed: true,
      minutes: null,
      sizeGb: j.size ? Math.round((j.size / 1073741824) * 100) / 100 : null,
      youtube: !!j.youtubeUrl,
      shareIndex: jKey(key),
      playable: !!j.r2Key,
    });
  }
  for (const r of legacy) {
    if (r.r2DeletedAt || !r.r2Done) continue;
    out.push({
      id: r.uuid,
      kind: "legacy",
      date: r.date,
      baseTitle: r.match?.title ?? r.naming?.title ?? "",
      baseKai: r.naming?.kai ?? "その他",
      managed: !!r.match?.jobRecId,
      minutes: r.durationSec ? Math.round(r.durationSec / 60) : null,
      sizeGb: Math.round((r.totalSize / 1073741824) * 100) / 100,
      youtube: !!r.match?.youtubeUrl,
      shareIndex: lKey(r.uuid),
      jobShareIndex: r.match?.jobRecId ? jKey(jobKeyOf(r.match.jobRecId)) : undefined,
      playable: !!mainVideo(r.files)?.r2Key,
    });
  }
  return out;
}

async function listKeys(store: R2Bucket, prefix: string): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await store.list({ prefix, cursor });
    for (const o of page.objects) out.add(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}

/** 共有の控えを引く。have を渡すと、置き場の一覧に無いものは読まない（読む回数を抑える） */
async function shareOf(env: ArchiveEnv, it: Item, have?: Set<string>): Promise<ShareRec | null> {
  for (const idx of [it.shareIndex, it.jobShareIndex]) {
    if (!idx || (have && !have.has(idx))) continue;
    const token = (await (await env.STORE.get(idx))?.text()) ?? "";
    if (!token) continue;
    const rec = await readJson<ShareRec>(env.STORE, tKey(token));
    if (rec) return rec;
  }
  return null;
}

export async function shelfList(env: ArchiveEnv): Promise<{ ok: true; total: number; counts: Record<string, number>; short_link_ready: boolean; rows: ShelfRow[] }> {
  const all = await items(env);
  const metas = await listJson<Meta>(env.STORE, "shelf/meta/");
  const sugs = await listJson<Sug>(env.STORE, "shelf/sug/");
  const shortOk = await shortHostOk(env.STORE);
  const rows: ShelfRow[] = [];
  // 共有の控えは数十件なので 1 件ずつ引く（並べて引く）
  const have = new Set([...(await listKeys(env.STORE, "share/j/")), ...(await listKeys(env.STORE, "share/l/"))]);
  const shares = await Promise.all(all.map((it) => shareOf(env, it, have)));
  all.forEach((it, i) => {
    const meta = metas.get(metaKey(it.id));
    const sug = sugs.get(sugKey(it.id));
    const kai = meta?.kai ?? it.baseKai;
    const title = (!it.managed && meta?.title) || it.baseTitle || `${it.date}｜${kai}｜録画`;
    const issues: string[] = [];
    const md = titleMonthDay(title);
    if (md && it.date) {
      const [, mm, dd] = it.date.split("-").map(Number);
      if (md !== `${mm}-${dd}`) issues.push("名前の日付と収録日が合わない");
    }
    if ((it.sizeGb !== null && it.sizeGb < 0.01) || (it.minutes !== null && it.minutes < 1)) issues.push("1 分未満・ほぼ空");
    if (!it.playable) issues.push("見る画面で流せる動画が無い（音声だけなど）");
    rows.push({
      id: it.id,
      kind: it.kind,
      date: it.date,
      title,
      kai,
      managed: it.managed,
      minutes: it.minutes,
      size_gb: it.sizeGb,
      youtube: it.youtube,
      share: shareView(shares[i], shortOk),
      suggest_kai: kai === "その他" && sug?.kai && sug.kai !== "その他" ? { kai: sug.kai, why: sug.why } : null,
      // 日付が合わないものは中身が別の回の見込みなので、そろえる案は出さず点検に回す
      suggest_name: it.managed || issues.includes("名前の日付と収録日が合わない") ? null : canonicalName(it.date, kai, title),
      issues,
    });
  });
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const counts: Record<string, number> = { all: rows.length };
  for (const k of KAIS) counts[k] = rows.filter((r) => r.kai === k).length;
  counts.shared = rows.filter((r) => r.share?.state === "on").length;
  counts.suggest = rows.filter((r) => r.suggest_kai || r.suggest_name).length;
  counts.issues = rows.filter((r) => r.issues.length).length;
  return { ok: true, total: rows.length, counts, short_link_ready: shortOk, rows };
}

async function findItem(env: ArchiveEnv, id: string): Promise<Item | null> {
  return (await items(env)).find((x) => x.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* 共有リンク                                                          */
/* ------------------------------------------------------------------ */

export async function shareIssue(env: ArchiveEnv, id: string): Promise<object> {
  const it = await findItem(env, String(id ?? ""));
  if (!it) return { ok: false, error: "not_found", note: "id は棚の一覧の id をそのまま渡す" };
  if (!it.playable) return { ok: false, error: "no_video", note: "この録画には見る画面で流せる動画がありません（音声だけなど）" };
  const shortOk = await shortHostOk(env.STORE);
  const had = await shareOf(env, it);
  if (had) {
    if (await ensureShort(env.STORE, had)) await env.STORE.put(tKey(had.token), JSON.stringify(had));
    return { ok: true, created: false, link: linkFor(had, shortOk), state: shareView(had, shortOk)?.state };
  }
  const metas = await readJson<Meta>(env.STORE, metaKey(it.id));
  const token = newToken();
  const rec: ShareRec = {
    token,
    jobKey: it.kind === "new" ? jobKeyOf(it.id) : "",
    ...(it.kind === "legacy" ? { legacyId: it.id } : {}),
    title: (!it.managed && metas?.title) || it.baseTitle || "録画",
    createdAt: new Date().toISOString(),
    views: 0,
  };
  await ensureShort(env.STORE, rec);
  await env.STORE.put(tKey(token), JSON.stringify(rec));
  await env.STORE.put(it.shareIndex, token);
  return { ok: true, created: true, link: linkFor(rec, shortOk) };
}

export async function shareSet(env: ArchiveEnv, id: string, opts: { stopped?: boolean; expires?: string | null }): Promise<object> {
  const it = await findItem(env, String(id ?? ""));
  if (!it) return { ok: false, error: "not_found" };
  const rec = await shareOf(env, it);
  if (!rec) return { ok: false, error: "no_link", note: "先にリンクを発行する（shareIssue）" };
  if (opts.stopped !== undefined) rec.stopped = opts.stopped || undefined;
  if (opts.expires !== undefined) {
    const e = (opts.expires ?? "").trim();
    if (e && !/^\d{4}-\d{2}-\d{2}$/.test(e)) return { ok: false, error: "bad_date", note: "期限は YYYY-MM-DD" };
    rec.expires = e || undefined;
  }
  await env.STORE.put(tKey(rec.token), JSON.stringify(rec));
  return { ok: true, share: shareView(rec, await shortHostOk(env.STORE)) };
}

/* ------------------------------------------------------------------ */
/* 名前と会の種類                                                      */
/* ------------------------------------------------------------------ */

export async function metaSet(env: ArchiveEnv, list: { id: string; title?: string; kai?: string }[]): Promise<object> {
  const all = new Map((await items(env)).map((x) => [x.id, x]));
  const done: string[] = [];
  const refused: { id: string; why: string }[] = [];
  for (const m of (list ?? []).slice(0, 600)) {
    const it = all.get(String(m.id ?? ""));
    if (!it) {
      refused.push({ id: String(m.id), why: "見つからない" });
      continue;
    }
    if (m.kai !== undefined && !(KAIS as readonly string[]).includes(m.kai)) {
      refused.push({ id: it.id, why: "会の種類は セミナー・打ち合わせ・個別相談・Zoom添削・その他 のどれか" });
      continue;
    }
    const title = (m.title ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
    if (m.title !== undefined && it.managed) {
      refused.push({ id: it.id, why: "管理シートに行がある録画の名前は、シートの E 列で変える" });
      continue;
    }
    const cur = (await readJson<Meta>(env.STORE, metaKey(it.id))) ?? { updatedAt: "" };
    if (m.kai !== undefined) cur.kai = m.kai as Kai;
    if (m.title !== undefined) cur.title = title || undefined;
    cur.updatedAt = new Date().toISOString();
    await env.STORE.put(metaKey(it.id), JSON.stringify(cur));
    // リンクの題名もそろえる（見る画面の題名）
    const rec = await shareOf(env, it);
    if (rec && m.title !== undefined && title && rec.title !== title) {
      rec.title = title;
      await env.STORE.put(tKey(rec.token), JSON.stringify(rec));
    }
    done.push(it.id);
  }
  return { ok: refused.length === 0, done: done.length, refused };
}

/* ------------------------------------------------------------------ */
/* 「その他」の会の種類の案（AI）                                       */
/* ------------------------------------------------------------------ */

const SUG_MODEL = "@cf/openai/gpt-oss-120b"; // 名前付け（archive.ts）と同じ

async function transcriptOf(env: ArchiveEnv, it: Item): Promise<string | null> {
  let key: string | null = null;
  if (it.kind === "legacy") {
    const r = await readJson<LegacyRec>(env.STORE, recKey(it.id));
    key = r?.files.find((f) => f.type === "TRANSCRIPT" && f.r2Key)?.r2Key ?? null;
  } else {
    const j = await readJson<JobLike>(env.STORE, jobKeyOf(it.id));
    key = j?.r2Key ? j.r2Key.replace(/\.mp4$/i, ".vtt") : null;
  }
  if (!key) return null;
  const o = await env.STORE.get(key);
  if (!o) return null;
  const lines = (await o.text())
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !l.includes("-->"));
  // 話者を数えるために「名前:」は残すが、名前そのものは A・B… に置き換える
  const who = new Map<string, string>();
  const body = lines
    .map((l) => {
      const m = l.match(/^([^:：]{1,30})[:：]\s*(.*)$/);
      if (!m) return l;
      if (!who.has(m[1])) who.set(m[1], `話者${String.fromCharCode(65 + (who.size % 26))}`);
      return `${who.get(m[1])}: ${m[2]}`;
    })
    .join("\n");
  return `話者の数：${who.size}\n` + body.slice(0, 6000);
}

/** 「その他」でまだ案の無い録画に、会の種類の案を付ける（1 回に多くて limit 本） */
export async function suggestKai(env: ArchiveEnv, limit = 8): Promise<object> {
  if (!env.AI) return { ok: false, error: "no_ai" };
  const metas = await listJson<Meta>(env.STORE, "shelf/meta/");
  const sugs = await listJson<Sug>(env.STORE, "shelf/sug/");
  const todo = (await items(env)).filter(
    (it) => (metas.get(metaKey(it.id))?.kai ?? it.baseKai) === "その他" && !sugs.has(sugKey(it.id)),
  );
  const n = Math.max(1, Math.min(20, Math.floor(limit)));
  let made = 0;
  let none = 0;
  for (const it of todo.slice(0, n)) {
    const text = await transcriptOf(env, it);
    let sug: Sug = { kai: null, why: "文字起こしが無い", at: new Date().toISOString() };
    if (text) {
      try {
        const res = await env.AI.run(SUG_MODEL as keyof AiModels, {
          instructions:
            "Zoom の録画の文字起こしを読み、会の種類を 1 つ選ぶ。選べるのは セミナー（講師が複数の参加者に教える）・打ち合わせ（仕事の相談や会議）・個別相談（1 対 1 で相手の悩みを聞く）・Zoom添削（相手の文章や投稿を直す）・その他 のどれか。" +
            "答えは JSON だけ：{\"kai\":\"…\",\"why\":\"30 文字以内の理由\"}。理由に人の名前を書かない。",
          input: text,
          reasoning: { effort: "low" },
        } as never);
        const j = (parseJson(outputText(res)) ?? {}) as { kai?: string; why?: string };
        const kai = (KAIS as readonly string[]).includes(j.kai ?? "") ? (j.kai as Kai) : null;
        const why = String(j.why ?? "").replace(/[\r\n]/g, " ").slice(0, 40);
        sug = { kai, why: /(さん|様|さま)/.test(why) ? "" : why, at: new Date().toISOString() };
      } catch (e) {
        sug = { kai: null, why: "AI が答えなかった", at: new Date().toISOString() };
      }
    }
    if (sug.kai && sug.kai !== "その他") made++;
    else none++;
    await env.STORE.put(sugKey(it.id), JSON.stringify(sug));
  }
  return { ok: true, looked: Math.min(n, todo.length), suggested: made, no_suggestion: none, remaining: Math.max(0, todo.length - n) };
}
