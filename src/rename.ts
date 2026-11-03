/**
 * zoom-to-youtube / rename.ts（第25版・2026-11-03 開発部・Naoki 依頼「R2 と YouTube の名前も管理したい。あとで探せるように」）
 *
 * 管理シートの E タイトルを、録画の名前の正本にする。
 *   ・E を書き直すと、次の実行で R2 のファイル名・YouTube の題名・保管の記録（job/・legacy/rec/）の題名をそろえる
 *   ・R2 には名前を変える機能が無いので、新しい名前へ写し、大きさが合うのを確かめてから古い方を消す。
 *     写せなかったら古い方は消さずに、その行の R 列へ失敗を書いて止める
 *   ・R 列「R2（自動）」に R2 の置き場（主のファイル）を書く。どこに入ったかを 1 行で見るため
 *   ・初めて見た行は、いまの E を「そろえ済み」として覚えるだけで何も変えない（作った日より前の行を勝手に付け直さないため）
 *   ・YouTube の題名は許可に youtube.force-ssl が要る。足りなければ YouTube だけ飛ばして R2 と記録はそろえる
 */
import { fileSafe, R2_PREFIX } from "./archive";
import { recKey, type LegacyRec } from "./legacy";

export interface RenameEnv {
  STORE: R2Bucket;
}

export interface RenameResult {
  seen: number;
  baselined: number;
  renamed: number;
  failed: number;
  notes: string[];
  failures: string[];
}

const MARK_PREFIX = "manage/named/";
const R_HEADER = "R2（自動）";
const PER_RUN = 3;
/** R2 の 1 回の put の上限（5 GB）。これより大きいファイルは写せないので止める */
const PUT_LIMIT = 5 * 1000 * 1000 * 1000;

interface Mark {
  title: string;
  at: string;
  r2?: string;
}

interface JobLike {
  recId: string;
  share?: string;
  title?: string;
  date?: string;
  naming?: { title?: string; mode?: string; kai?: string };
  r2Key?: string;
  r2Done?: boolean;
  r2VttDone?: boolean;
  r2DeletedAt?: string;
  youtubeId?: string;
  youtubeUrl?: string;
  updatedAt?: string;
}

function markKey(id: string): string {
  return MARK_PREFIX + id.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
}

/** 共有リンク → job/ の置き場。job/ は Zoom の録画の番号で置かれ、管理シートの処理ID とは別なので、台帳の共有リンクで結ぶ */
async function jobIndex(store: R2Bucket): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await store.list({ prefix: "job/", cursor });
    for (const o of page.objects) {
      const j = await readJson<JobLike>(store, o.key);
      if (j?.share) map.set(j.share.trim(), o.key);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return map;
}

async function readJson<T>(store: R2Bucket, key: string): Promise<T | null> {
  const o = await store.get(key);
  return o ? (JSON.parse(await o.text()) as T) : null;
}

function videoId(url: string | undefined): string | null {
  const m = (url ?? "").match(/[?&]v=([A-Za-z0-9_-]{6,})/) ?? (url ?? "").match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

/** 新しい名前の土台（拡張子なし）。ほかの録画と重ならない名前にする */
export async function freshBase(store: R2Bucket, date: string, title: string, mainExt: string): Promise<string> {
  const [y, m] = date.split("-");
  // E タイトルの先頭に日付が付いていれば、ファイル名では日付を 2 回書かない
  const body = fileSafe(title.replace(/^\d{4}-\d{2}-\d{2}\s*[｜|]\s*/, ""), 60);
  const base = `${R2_PREFIX}${y}/${m}/${date}_${body}`;
  for (let n = 1; n < 50; n++) {
    const b = n === 1 ? base : `${base}_${n}`;
    if (!(await store.head(`${b}${mainExt}`))) return b;
  }
  return `${base}_${Date.now().toString(36)}`;
}

/** 古い置き場 → 新しい置き場の対応。主のファイルの土台を差し替え、ほかは後ろの部分を残す */
export function planKeys(keys: string[], mainKey: string, newBase: string): Map<string, string> {
  const dot = mainKey.lastIndexOf(".");
  const oldBase = dot > 0 ? mainKey.slice(0, dot) : mainKey;
  const plan = new Map<string, string>();
  for (const k of keys) {
    if (k.startsWith(oldBase)) plan.set(k, newBase + k.slice(oldBase.length));
    else plan.set(k, `${newBase}_${k.slice(k.lastIndexOf("/") + 1)}`);
  }
  return plan;
}

/** 1 本写す。大きさが合うのを確かめてから true。古い方はまだ消さない */
async function copyObject(store: R2Bucket, from: string, to: string): Promise<string | null> {
  const src = await store.get(from);
  if (!src) return `R2 に元のファイルが無い（${from}）`;
  if (src.size > PUT_LIMIT) return `5 GB を超えるので写せない（${from}）`;
  const { readable, writable } = new FixedLengthStream(src.size);
  const piping = src.body.pipeTo(writable);
  await store.put(to, readable, { httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
  await piping;
  const head = await store.head(to);
  if (!head || head.size !== src.size) return `写した大きさが合わない（${to}）`;
  return null;
}

async function setYoutubeTitle(ytToken: string, id: string, title: string): Promise<string | null> {
  const got = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}`, {
    headers: { authorization: `Bearer ${ytToken}` },
  });
  if (!got.ok) return `YouTube の動画を読めない（${got.status}）`;
  const body = (await got.json()) as { items?: { snippet?: Record<string, unknown> }[] };
  const snippet = body.items?.[0]?.snippet;
  if (!snippet) return "YouTube に動画が見つからない";
  const res = await fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet", {
    method: "PUT",
    headers: { authorization: `Bearer ${ytToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      id,
      snippet: {
        title: title.slice(0, 100),
        description: snippet.description ?? "",
        categoryId: snippet.categoryId ?? "22",
        tags: snippet.tags,
        defaultLanguage: snippet.defaultLanguage,
      },
    }),
  });
  if (res.ok) return null;
  const raw = (await res.text()).slice(0, 200);
  if (res.status === 403 && /insufficient|scope|Permission/i.test(raw)) {
    return "YouTube の許可に題名を変える権限が無い（/oauth/start の youtube を通し直す）";
  }
  return `YouTube の題名を変えられない（${res.status}：${raw}）`;
}

interface SheetRef {
  tab: string;
  rowNo: number;
  title: string;
  id: string;
  rCell: string;
}

/**
 * 管理シートの全部のタブを読み、E タイトルと「そろえ済み」の印が違う行をそろえる。
 * readRows は index.ts / manage.ts から差し込む（Google の鍵まわりを持たないため）
 */
export async function syncNames(
  env: RenameEnv,
  rows: { tab: string; rowNo: number; values: string[] }[],
  shareById: Map<string, string>,
  writeCells: (cells: { range: string; values: string[][] }[]) => Promise<void>,
  ytToken: () => Promise<string>,
  out: (s: string) => void,
): Promise<RenameResult> {
  const res: RenameResult = { seen: 0, baselined: 0, renamed: 0, failed: 0, notes: [], failures: [] };
  const writes: { range: string; values: string[][] }[] = [];
  const headerTabs = new Set<string>();
  let budget = PER_RUN;

  const refs: SheetRef[] = [];
  for (const r of rows) {
    const title = (r.values[4] ?? "").trim();
    const id = (r.values[14] ?? "").trim();
    if (!title || !id) continue;
    refs.push({ tab: r.tab, rowNo: r.rowNo, title, id, rCell: (r.values[17] ?? "").trim() });
    headerTabs.add(r.tab);
  }
  for (const tab of headerTabs) writes.push({ range: `${tab}!R1`, values: [[R_HEADER]] });

  let jobs: Map<string, string> | null = null;
  for (const ref of refs) {
    res.seen++;
    const mark = await readJson<Mark>(env.STORE, markKey(ref.id));
    if (mark && mark.title === ref.title) {
      // そろえ済み：控えは読まずに、R 列だけ埋める
      if (mark.r2 && ref.rCell !== mark.r2 && !ref.rCell.startsWith("失敗")) writes.push({ range: `${ref.tab}!R${ref.rowNo}`, values: [[mark.r2]] });
      continue;
    }
    const share = shareById.get(ref.id);
    if (share) jobs ??= await jobIndex(env.STORE);
    const jk = share ? jobs?.get(share) : undefined;
    const job = jk ? await readJson<JobLike>(env.STORE, jk) : null;
    if (!jk || !job) {
      // 控えに結び付かない行（録画の無い予定の行など）：覚えるだけにして、毎回探し直さない
      await env.STORE.put(markKey(ref.id), JSON.stringify({ title: ref.title, at: new Date().toISOString() } satisfies Mark));
      res.baselined++;
      continue;
    }
    const ownR2 = !!(job.r2Key && job.r2Done && !job.r2DeletedAt);
    const legacy = ownR2 ? null : await findLegacy(env, job.recId);

    // R2 の置き場（主のファイルと、ほかのファイル）
    let mainKey = "";
    let keys: string[] = [];
    if (ownR2 && job.r2Key) {
      mainKey = job.r2Key;
      keys = [job.r2Key];
      if (job.r2VttDone) keys.push(job.r2Key.replace(/\.mp4$/, ".vtt"));
    } else if (legacy && legacy.r2Done && !legacy.r2DeletedAt) {
      keys = legacy.files.map((f) => f.r2Key).filter((k): k is string => !!k);
      mainKey = keys.find((k) => k.endsWith(".mp4")) ?? keys[0] ?? "";
    }

    if (!mark) {
      // 初めて見た行：いまの名前をそろえ済みとして覚えるだけ（前からある行を勝手に付け直さない）。
      // ただし 11/03 以降に録った録画は、控えの題名（AI が付けた名前）を起点にし、E が違えばそろえる
      // （第25版の初日に、名前を変える段が控えを引けずに空回りしていた間の書き直しを拾うため）
      const recent = (job.date ?? "") >= "2026-11-03";
      const start = recent ? (job.naming?.title ?? job.title ?? ref.title) : ref.title;
      await env.STORE.put(markKey(ref.id), JSON.stringify({ title: start, at: new Date().toISOString(), r2: mainKey } satisfies Mark));
      if (start === ref.title) {
        if (mainKey && ref.rCell !== mainKey) writes.push({ range: `${ref.tab}!R${ref.rowNo}`, values: [[mainKey]] });
        res.baselined++;
        continue;
      }
    }
    if (budget <= 0) continue;
    budget--;

    const label = `${job.date ?? legacy?.date ?? ""}「${ref.title}」`;
    out(`  名前をそろえる：${label}`);
    const problems: string[] = [];

    // 1. R2：新しい名前へ写し、全部写せてから古い方を消す
    let newMain = mainKey;
    if (mainKey) {
      const date = job.date ?? legacy?.date ?? mainKey.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      const ext = mainKey.slice(mainKey.lastIndexOf("."));
      const base = await freshBase(env.STORE, date, ref.title, ext);
      const plan = planKeys(keys, mainKey, base);
      let bad: string | null = null;
      const copied: string[] = [];
      for (const [from, to] of plan) {
        bad = await copyObject(env.STORE, from, to);
        if (bad) break;
        copied.push(to);
      }
      if (bad) {
        // 写せた分は消して元に戻す。古い方は残っている
        for (const k of copied) await env.STORE.delete(k);
        writes.push({ range: `${ref.tab}!R${ref.rowNo}`, values: [[`失敗：${bad}`]] });
        res.failed++;
        res.failures.push(`名前をそろえられなかった：${label}：${bad}`);
        continue;
      }
      newMain = plan.get(mainKey) as string;
      // 記録を先に新しい置き場へ書き換えてから、古い方を消す
      if (job.r2Key === mainKey) {
        job.r2Key = newMain;
      } else if (legacy) {
        for (const f of legacy.files) if (f.r2Key && plan.has(f.r2Key)) f.r2Key = plan.get(f.r2Key);
      }
      job.title = ref.title;
      if (job.naming) job.naming.title = ref.title;
      job.updatedAt = new Date().toISOString();
      await env.STORE.put(jk, JSON.stringify(job));
      if (legacy) await saveLegacyTitle(env, legacy, ref.title);
      for (const from of plan.keys()) await env.STORE.delete(from);
    } else {
      job.title = ref.title;
      if (job.naming) job.naming.title = ref.title;
      job.updatedAt = new Date().toISOString();
      await env.STORE.put(jk, JSON.stringify(job));
      if (legacy) await saveLegacyTitle(env, legacy, ref.title);
    }

    // 2. YouTube の題名
    const vid = job.youtubeId ?? videoId(job.youtubeUrl) ?? videoId(legacy?.match?.youtubeUrl);
    if (vid) {
      try {
        const why = await setYoutubeTitle(await ytToken(), vid, ref.title);
        if (why) problems.push(why);
      } catch (e) {
        problems.push(`YouTube の許可を読めない：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await env.STORE.put(markKey(ref.id), JSON.stringify({ title: ref.title, at: new Date().toISOString(), r2: newMain } satisfies Mark));
    writes.push({ range: `${ref.tab}!R${ref.rowNo}`, values: [[newMain || "R2 に無い"]] });
    res.renamed++;
    res.notes.push(`名前をそろえた：${label}${newMain ? `（R2 ${newMain}）` : ""}`);
    if (problems.length) res.failures.push(`名前をそろえた（一部）：${label}：${problems.join("・")}`);
    out(`    R2 ${newMain || "無し"}${problems.length ? `／${problems.join("・")}` : "／YouTube も変えた"}`);
  }

  await writeCells(writes);
  return res;
}

async function findLegacy(env: RenameEnv, recId: string): Promise<LegacyRec | null> {
  const idx = await readJson<Record<string, string>>(env.STORE, "manage/named-index.json");
  const uuid = idx?.[recId];
  if (uuid) {
    const r = await readJson<LegacyRec>(env.STORE, recKey(uuid));
    if (r && r.match?.jobRecId === recId) return r;
  } else if (idx) {
    return null;
  }
  // 表が無いか、表の結び付きが古いときだけ、古い録画を全部見て作り直す（519 件ほど）
  const map: Record<string, string> = {};
  let found: LegacyRec | null = null;
  let cursor: string | undefined;
  for (let g = 0; g < 50; g++) {
    const page = await env.STORE.list({ prefix: "legacy/rec/", cursor });
    for (const o of page.objects) {
      const r = await readJson<LegacyRec>(env.STORE, o.key);
      const jr = r?.match?.jobRecId;
      if (r && jr) {
        map[jr] = r.uuid;
        if (jr === recId) found = r;
      }
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  await env.STORE.put("manage/named-index.json", JSON.stringify(map));
  return found;
}

async function saveLegacyTitle(env: RenameEnv, r: LegacyRec, title: string): Promise<void> {
  if (r.match) r.match.title = title;
  if (r.naming) r.naming = { ...r.naming, title };
  r.updatedAt = new Date().toISOString();
  await env.STORE.put(recKey(r.uuid), JSON.stringify(r));
}
