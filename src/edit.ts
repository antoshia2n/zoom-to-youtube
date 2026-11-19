/**
 * zoom-to-youtube / src/edit.ts（第53版・2026-11-19 開発部・動画の自動編集 便 1）
 *
 * Zoom の録画を自動で編集する口。編集そのもの（ジェットカット・音質・テロップ・上の帯）は
 * GitHub Actions（.github/workflows/edit.yml・scripts/edit.py）が ffmpeg で行う。こちらは渡すのと受け取るのだけ。
 * 作る前の 1 枚に Naoki OK（2026-11-19 17:27）。
 *
 *   GET  /edit/source?id=…    録画の日付・題名・会の種類・目次（秒と見出し）・文字起こしがあるか
 *   GET  /edit/file?id=…      主の動画を R2 から流す
 *   GET  /edit/vtt?id=…       時刻付きの文字起こし（VTT）
 *   POST /edit/up-start?id=…  編集版を入れ始める（手で上げた動画と同じ棚に「【編集版】」で並ぶ）
 *   PUT  /edit/up-part?u=…&n=…  1 片（16MB）
 *   POST /edit/up-done?u=…    まとめて棚を作り直す
 *
 * 守り：GitHub が発行する本人確認（OIDC）だけを受ける。このリポジトリの main の edit.yml から来たものだけ。
 * 実行の記録は公開なので、こちらから返す値のうち題名・目次・文字起こしは /edit/source と /edit/vtt だけで渡し、
 * 編集の側（edit.py）は記録に出さない。
 */
import type { ArchiveEnv } from "./archive";
import { mainVideo, recKey, type LegacyRec } from "./legacy";
import { parseDescription } from "./player";
import { readJson, type ShareJob } from "./share";
import { refreshShelfItems, shelfMetaById } from "./shelf";
import { checkGithub } from "./transcribe";
import { uploadComplete, uploadPart, uploadStart } from "./upload";

const AUDIENCE = "zoom-to-youtube-edit";
const WORKFLOW = "antoshia2n/zoom-to-youtube/.github/workflows/edit.yml@refs/heads/main";
const LAST_KEY = "edit/last.json";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

interface Source {
  id: string;
  date: string;
  title: string;
  kai: string;
  videoKey: string;
  vttKey: string | null;
  description?: string;
}

async function sourceOf(env: ArchiveEnv, id: string): Promise<Source | null> {
  if (!/^[A-Za-z0-9._=+-]{6,80}$/.test(id)) return null;
  const meta = (await shelfMetaById(env)).get(id) ?? {};
  const job = await readJson<ShareJob & { kai?: string }>(env.STORE, "job/" + id.replace(/[^A-Za-z0-9._-]/g, "_") + ".json");
  if (job?.r2Key && !job.r2DeletedAt) {
    return {
      id,
      date: job.date ?? "",
      title: meta.title ?? job.naming?.title ?? job.title ?? "",
      kai: meta.kai ?? job.kai ?? "",
      videoKey: job.r2Key,
      vttKey: job.r2Key.replace(/\.mp4$/i, ".vtt"),
      description: job.naming?.description,
    };
  }
  const r = await readJson<LegacyRec>(env.STORE, recKey(id));
  if (r && r.r2Done && !r.r2DeletedAt) {
    const v = mainVideo(r.files);
    if (!v?.r2Key) return null;
    const t = r.files.find((f) => f.type === "TRANSCRIPT" && f.r2Done && f.r2Key);
    return {
      id,
      date: r.date,
      title: meta.title ?? r.match?.title ?? r.naming?.title ?? "",
      kai: meta.kai ?? r.naming?.kai ?? "",
      videoKey: v.r2Key,
      vttKey: t?.r2Key ?? null,
      description: r.naming?.description,
    };
  }
  return null;
}

export async function handleEdit(req: Request, env: ArchiveEnv, url: URL): Promise<Response> {
  let why: string | null;
  try {
    why = await checkGithub(env, req, AUDIENCE, WORKFLOW);
  } catch (e) {
    why = `本人確認の途中で止まった：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
  if (why) return json({ ok: false, error: why }, 401);

  const p = url.pathname;
  if (p === "/edit/up-part" && req.method === "PUT") {
    return json(await uploadPart(env, url.searchParams.get("u") ?? "", Number(url.searchParams.get("n")), req.body));
  }
  if (p === "/edit/up-done" && req.method === "POST") {
    const r = (await uploadComplete(env, url.searchParams.get("u") ?? "")) as { ok?: boolean; id?: string };
    if (r.ok) {
      await refreshShelfItems(env);
      await env.STORE.put(LAST_KEY, JSON.stringify({ at: new Date().toISOString(), upload_id: r.id }));
    }
    return json(r);
  }

  const id = url.searchParams.get("id") ?? "";
  const src = await sourceOf(env, id);
  if (!src) return json({ ok: false, error: "録画が無い（棚の id を渡す）" }, 404);

  if (p === "/edit/source") {
    const { chapters } = parseDescription(src.description);
    const hasVtt = !!(src.vttKey && (await env.STORE.head(src.vttKey)));
    return json({ ok: true, id: src.id, date: src.date, title: src.title, kai: src.kai, chapters, has_vtt: hasVtt });
  }
  if (p === "/edit/file") {
    const o = await env.STORE.get(src.videoKey);
    if (!o) return json({ ok: false, error: "R2 に動画が無い" }, 404);
    return new Response(o.body, { headers: { "content-type": "video/mp4", "content-length": String(o.size) } });
  }
  if (p === "/edit/vtt") {
    const o = src.vttKey ? await env.STORE.get(src.vttKey) : null;
    if (!o) return json({ ok: false, error: "文字起こしが無い" }, 404);
    return new Response(o.body, { headers: { "content-type": "text/vtt; charset=utf-8" } });
  }
  if (p === "/edit/up-start" && req.method === "POST") {
    const b = (await req.json()) as { size?: number };
    const title = `【編集版】${src.title.replace(/^\d{4}-\d{2}-\d{2}｜[^｜]*｜/, "") || src.date}`;
    return json(
      await uploadStart(env, {
        file_name: `edit_${src.id.slice(0, 12)}.mp4`,
        size: Number(b.size),
        date: src.date,
        title,
        kai: src.kai,
        labels: ["自動編集"],
        by: "自動編集（edit.yml）",
      }),
    );
  }
  return json({ ok: false, error: "口が無い" }, 404);
}
