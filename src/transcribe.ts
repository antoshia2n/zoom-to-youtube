/**
 * zoom-to-youtube / src/transcribe.ts（第47版・2026-11-17 開発部）
 *
 * 文字起こしが無い録画（naming が no_transcript）に、OpenAI の whisper-1 で時刻付きの文字起こしを足す口。
 * 音声を切るのは GitHub Actions（.github/workflows/transcribe.yml）。こちらは渡すのと受け取るのだけ。
 *
 *   GET  /transcribe/next?limit=N   まだの録画を N 本まで（費用が上限に届いていたら 0 本）
 *   GET  /transcribe/file?id=…      録画の音声（なければ主の動画）を R2 から流す
 *   POST /transcribe/put?id=…       時刻付きの文字起こし（VTT）を受け取って R2 に入れ、題名付けを通す
 *   POST /transcribe/report         実行ごとの結果（本数・分・切れ目の確かめ・失敗）を控える
 *
 * 守り：GitHub が発行する本人確認（OIDC の JWT）だけを受ける。このリポジトリの main の
 *   transcribe.yml から来たものだけ。合言葉は持たない。
 * 費用：1 分 $0.006（whisper-1）で日ごとに控え、合計が $80 に届いたら次を渡さない。
 * 実行の記録は公開なので、こちらから返す値に題名・文字起こしの中身は入れない（日付と番号と分だけ）。
 */
import { nameRecording, type ArchiveEnv, type Naming } from "./archive";
import { legacyRows, mainVideo, recKey, type LegacyFile, type LegacyRec } from "./legacy";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "zoom-to-youtube-transcribe";
const REPO = "antoshia2n/zoom-to-youtube";
const WORKFLOW = `${REPO}/.github/workflows/transcribe.yml@refs/heads/main`;
const USD_PER_MIN = 0.006;
const USD_STOP = 80;
const LEDGER_KEY = "transcribe/ledger.json";
const JWKS_KEY = "transcribe/jwks.json";
const REJECT_KEY = "transcribe/last-reject.json";
/** 断ったときに見比べる値（鍵ではない・どの実行から来たかだけ） */
let lastClaims: Record<string, unknown> | null = null;

export interface TranscribeLedger {
  /** 日本時間の日付 → その日に送った分 */
  days: Record<string, number>;
  minutes: number;
  usd: number;
  done: string[];
  failed: Record<string, string>;
  /** 第49版：録画ごとの切れ目の確かめ（区切りの数・切れ目の数・飛び戻り） */
  checks?: Record<string, { date: string; minutes: number; parts: number; boundaries: number; jumps: number; naming: string }>;
  /** 最後の実行の控え（題名なし） */
  lastRun?: {
    at: string;
    sent: number;
    ok: number;
    failed: number;
    minutes: number;
    boundaries: number;
    jumps: number;
    note?: string;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function jstDate(ms = Date.now()): string {
  return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
}

export async function loadLedger(env: ArchiveEnv): Promise<TranscribeLedger> {
  const o = await env.STORE.get(LEDGER_KEY);
  const base: TranscribeLedger = { days: {}, minutes: 0, usd: 0, done: [], failed: {} };
  return o ? { ...base, ...(JSON.parse(await o.text()) as TranscribeLedger) } : base;
}

async function saveLedger(env: ArchiveEnv, l: TranscribeLedger): Promise<void> {
  await env.STORE.put(LEDGER_KEY, JSON.stringify(l));
}

/* ------------------------------------------------------------------ */
/* GitHub の本人確認                                                    */
/* ------------------------------------------------------------------ */

function b64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function jwks(env: ArchiveEnv, fresh: boolean): Promise<{ keys: (JsonWebKey & { kid?: string })[] }> {
  if (!fresh) {
    const o = await env.STORE.get(JWKS_KEY);
    if (o) {
      const c = JSON.parse(await o.text()) as { at: number; keys: (JsonWebKey & { kid?: string })[] };
      if (Date.now() - c.at < 6 * 3600000) return c;
    }
  }
  const r = await fetch(`${ISSUER}/.well-known/jwks`);
  if (!r.ok) throw new Error(`GitHub の鍵の一覧が取れない（${r.status}）`);
  const got = (await r.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  await env.STORE.put(JWKS_KEY, JSON.stringify({ at: Date.now(), keys: got.keys }));
  return got;
}

/** 通れば null、通らなければ理由 */
export async function checkGithub(env: ArchiveEnv, req: Request): Promise<string | null> {
  lastClaims = null;
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/);
  if (!m) return "本人確認が無い";
  const parts = m[1].split(".");
  if (parts.length !== 3) return "本人確認の形が違う";
  let head: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    head = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    return "本人確認が読めない";
  }
  lastClaims = { iss: claims.iss, aud: claims.aud, repository: claims.repository, ref: claims.ref, job_workflow_ref: claims.job_workflow_ref, event_name: claims.event_name };
  if (head.alg !== "RS256") return "本人確認の方式が違う";
  let set = await jwks(env, false);
  let jwk = set.keys.find((k) => k.kid === head.kid);
  if (!jwk) {
    set = await jwks(env, true);
    jwk = set.keys.find((k) => k.kid === head.kid);
  }
  if (!jwk) return "本人確認の鍵が見つからない";
  const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return "本人確認の署名が合わない";
  const now = Date.now() / 1000;
  if (claims.iss !== ISSUER) return "発行元が違う";
  if (claims.aud !== AUDIENCE) return "宛先が違う";
  if (typeof claims.exp !== "number" || claims.exp < now) return "本人確認の期限切れ";
  if (claims.repository !== REPO) return "リポジトリが違う";
  if (claims.ref !== "refs/heads/main") return "main 以外から来た";
  if (claims.job_workflow_ref !== WORKFLOW) return "transcribe.yml 以外から来た";
  return null;
}

/* ------------------------------------------------------------------ */
/* 対象の録画                                                           */
/* ------------------------------------------------------------------ */

function audioOf(r: LegacyRec): LegacyFile | null {
  const m4a = r.files.filter((f) => f.type === "M4A" && f.r2Done && f.r2Key && f.size > 0).sort((a, b) => b.size - a.size)[0];
  if (m4a) return m4a;
  const v = mainVideo(r.files);
  return v && v.r2Done && v.r2Key && v.size > 0 ? v : null;
}

function targets(recs: LegacyRec[], l: TranscribeLedger): LegacyRec[] {
  const done = new Set(l.done);
  return recs
    .filter((r) => r.naming?.mode === "no_transcript" && r.r2Done && !r.r2DeletedAt && !done.has(r.uuid) && !l.failed[r.uuid] && audioOf(r))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function handleTranscribe(req: Request, env: ArchiveEnv, url: URL): Promise<Response> {
  let why: string | null;
  try {
    why = await checkGithub(env, req);
  } catch (e) {
    why = `本人確認の途中で止まった：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
  if (why) {
    // 第48版：断った理由を 1 つだけ控える（実行の記録が見えなくても zoom_archive__list で分かるように）
    await env.STORE.put(REJECT_KEY, JSON.stringify({ at: new Date().toISOString(), path: url.pathname, why, seen: lastClaims }));
    return json({ ok: false, error: why }, 401);
  }
  const l = await loadLedger(env);

  // 第49版：費用だけを見る軽い口（1 本ごとの確かめ用。録画の一覧は読まない）
  if (url.pathname === "/transcribe/budget") {
    return json({ ok: true, usd: l.usd, usd_stop: USD_STOP, ...(l.usd >= USD_STOP ? { stop: `費用が $${USD_STOP} に届いた（$${l.usd.toFixed(2)}）` } : {}) });
  }

  if (url.pathname === "/transcribe/next") {
    if (l.usd >= USD_STOP) return json({ ok: true, stop: `費用が $${USD_STOP} に届いた（$${l.usd.toFixed(2)}）`, rows: [] });
    const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit") ?? "5") || 5));
    const all = targets(await legacyRows(env), l);
    const rows = all.slice(0, limit).map((r) => {
      const f = audioOf(r) as LegacyFile;
      return { id: r.uuid, date: r.date, minutes: Math.round(r.durationSec / 60), ext: f.ext, mb: Math.round(f.size / 1048576) };
    });
    return json({ ok: true, remaining: all.length, usd: Math.round(l.usd * 100) / 100, usd_stop: USD_STOP, rows });
  }

  const id = url.searchParams.get("id") ?? "";
  const recObj = id ? await env.STORE.get(recKey(id)) : null;

  if (url.pathname === "/transcribe/file") {
    if (!recObj) return json({ ok: false, error: "録画が無い" }, 404);
    const r = JSON.parse(await recObj.text()) as LegacyRec;
    const f = audioOf(r);
    const o = f ? await env.STORE.get(f.r2Key as string) : null;
    if (!o) return json({ ok: false, error: "R2 にファイルが無い" }, 404);
    return new Response(o.body, { headers: { "content-type": "application/octet-stream", "content-length": String(o.size) } });
  }

  if (url.pathname === "/transcribe/put" && req.method === "POST") {
    if (!recObj) return json({ ok: false, error: "録画が無い" }, 404);
    const r = JSON.parse(await recObj.text()) as LegacyRec;
    const body = (await req.json()) as { vtt?: string; minutes?: number; error?: string; parts?: number; boundaries?: number; jumps?: number };
    if (body.error) {
      l.failed[r.uuid] = body.error.slice(0, 200);
      await saveLedger(env, l);
      return json({ ok: true, recorded: "failed" });
    }
    const vtt = body.vtt ?? "";
    if (!/^WEBVTT/.test(vtt) || !vtt.includes("-->")) return json({ ok: false, error: "VTT の形でない" }, 400);
    const minutes = Math.max(0, Number(body.minutes) || 0);
    // 費用は文字起こしが入ったかどうかに関わらず、送った分を控える
    const day = jstDate();
    l.days[day] = Math.round(((l.days[day] ?? 0) + minutes) * 10) / 10;
    l.minutes = Math.round((l.minutes + minutes) * 10) / 10;
    l.usd = Math.round(l.minutes * USD_PER_MIN * 100) / 100;

    const main = mainVideo(r.files) ?? audioOf(r);
    const base = (main?.r2Key ?? "").replace(/\.[A-Za-z0-9]+$/, "");
    if (!base) return json({ ok: false, error: "置き場が決められない" }, 400);
    const key = `${base}.vtt`;
    await env.STORE.put(key, vtt, { httpMetadata: { contentType: "text/vtt; charset=utf-8" } });
    const size = new TextEncoder().encode(vtt).length;
    const existing = r.files.find((f) => f.type === "TRANSCRIPT");
    if (existing) {
      existing.r2Key = key;
      existing.r2Done = true;
      existing.size = size;
    } else {
      r.files.push({ id: "openai-whisper", type: "TRANSCRIPT", ext: "vtt", recType: "openai_whisper", size, start: main?.start ?? r.start, url: "", r2Key: key, r2Done: true });
    }
    r.totalSize = r.files.reduce((a, f) => a + f.size, 0);
    // いまある題名付けを通す（YouTube の題名がある録画は、その題名を残す・移しのときと同じ）
    const human = r.match?.title ?? "";
    const n: Naming = await nameRecording(env, vtt, r.date, r.durationSec, human);
    r.naming = human ? { ...n, topic: r.naming?.topic ?? n.topic, note: [n.note, "YouTube の題名を使った", "文字起こし：OpenAI whisper-1"].filter(Boolean).join("・") } : { ...n, note: [n.note, "文字起こし：OpenAI whisper-1"].filter(Boolean).join("・") };
    r.updatedAt = new Date().toISOString();
    await env.STORE.put(recKey(r.uuid), JSON.stringify(r));
    if (!l.done.includes(r.uuid)) l.done.push(r.uuid);
    l.checks = l.checks ?? {};
    l.checks[r.uuid] = { date: r.date, minutes, parts: Number(body.parts) || 0, boundaries: Number(body.boundaries) || 0, jumps: Number(body.jumps) || 0, naming: r.naming.mode };
    delete l.failed[r.uuid];
    await saveLedger(env, l);
    return json({ ok: true, naming: r.naming.mode, usd: l.usd });
  }

  if (url.pathname === "/transcribe/report" && req.method === "POST") {
    const b = (await req.json()) as TranscribeLedger["lastRun"];
    if (b) {
      l.lastRun = { ...b, at: new Date().toISOString() };
      await saveLedger(env, l);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: "見つかりません" }, 404);
}

/** 第49版：VTT の中で時刻が戻る回数（前の行の始まりより 1 秒以上前に始まる行） */
function vttBackJumps(vtt: string): { cues: number; back: number } {
  let prev = -1;
  let back = 0;
  let cues = 0;
  for (const m of vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.\d{3}\s*-->/g)) {
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (prev >= 0 && t < prev - 1) back++;
    prev = t;
    cues++;
  }
  return { cues, back };
}

/** 第49版：控えに確かめが無い録画（第49版より前に入れた分）を、R2 の VTT から確かめて足す */
async function backfillChecks(env: ArchiveEnv, l: TranscribeLedger): Promise<boolean> {
  l.checks = l.checks ?? {};
  let changed = false;
  for (const id of l.done) {
    if (l.checks[id]) continue;
    const o = await env.STORE.get(recKey(id));
    if (!o) continue;
    const r = JSON.parse(await o.text()) as LegacyRec;
    const f = r.files.find((x) => x.type === "TRANSCRIPT" && x.r2Key);
    const v = f ? await env.STORE.get(f.r2Key as string) : null;
    if (!v) continue;
    const c = vttBackJumps(await v.text());
    l.checks[id] = { date: r.date, minutes: Math.round(r.durationSec / 60), parts: Math.ceil(r.durationSec / 600), boundaries: Math.max(0, Math.ceil(r.durationSec / 600) - 1), jumps: c.back, naming: r.naming?.mode ?? "未" };
    changed = true;
  }
  return changed;
}

/** zoom_archive__list に出す控え（題名なし） */
export async function transcribeSummary(env: ArchiveEnv): Promise<object> {
  const l = await loadLedger(env);
  if (await backfillChecks(env, l)) await saveLedger(env, l);
  const rj = await env.STORE.get(REJECT_KEY);
  return {
    last_reject: rj ? JSON.parse(await rj.text()) : null,
    done: l.done.length,
    failed: Object.keys(l.failed).length,
    failures: Object.entries(l.failed).slice(0, 10).map(([id, error]) => ({ id, error })),
    minutes: l.minutes,
    usd: l.usd,
    usd_stop: USD_STOP,
    days: l.days,
    last_run: l.lastRun ?? null,
    jumps_total: Object.values(l.checks ?? {}).reduce((a, c) => a + c.jumps, 0),
    checks: Object.values(l.checks ?? {}).slice(-10),
  };
}
