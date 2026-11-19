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
 *   POST /edit/plan          文字起こしの行（番号・秒・言葉）→ テロップの案（要約・型 A 通常／B 強調／C キーワード）
 *   POST /edit/up-start?id=…  編集版を入れ始める（手で上げた動画と同じ棚に「【編集版】」で並ぶ）
 *   PUT  /edit/up-part?u=…&n=…  1 片（16MB）
 *   POST /edit/up-done?u=…&id=…  まとめて棚を作り直し、会の種類とラベルを付ける
 *
 * 守り：GitHub が発行する本人確認（OIDC）だけを受ける。このリポジトリの main の edit.yml から来たものだけ。
 * 実行の記録は公開なので、こちらから返す値のうち題名・目次・文字起こしは /edit/source と /edit/vtt だけで渡し、
 * 編集の側（edit.py）は記録に出さない。
 */
import { outputText, parseJson, type ArchiveEnv } from "./archive";
import { mainVideo, recKey, type LegacyRec } from "./legacy";
import { parseDescription } from "./player";
import { readJson, type ShareJob } from "./share";
import { metaSet, refreshShelfItems, shelfMetaById } from "./shelf";
import { checkGithub } from "./transcribe";
import { uploadComplete, uploadPart, uploadStart } from "./upload";

const AUDIENCE = "zoom-to-youtube-edit";
const WORKFLOW = "antoshia2n/zoom-to-youtube/.github/workflows/edit.yml@refs/heads/main";
const LAST_KEY = "edit/last.json";
const AI_MODEL = "@cf/openai/gpt-oss-120b";
const KAIS = ["セミナー", "打ち合わせ", "個別相談", "Zoom添削", "その他"];

const PLAN_INSTRUCTIONS = [
  "あなたは日本の YouTube のプロの動画編集者です。セミナー録画の文字起こし（1 行＝[番号] 秒 言葉）から、画面に焼き込むテロップを作ります。",
  "文字起こしを全部テロップにしない。話し言葉をそのまま写さず、言いたいことを短く要約して「ギュッと」した言葉にする。",
  "1 つのテロップは 1〜3 行ぶんの話をまとめる。相づち・言いよどみ・雑談・繰り返し・段取りの話（聞こえますか等）にはテロップを付けない。",
  "type は A／B／C のどれか。A＝通常の要約テロップ（16 文字以内×2 行まで。改行は「／」）。B＝本当に大事な一言だけを強調（14 文字以内・1 行。この範囲で多くても 1 つ）。C＝話の芯になるキーワードや図式（例「理想 → 逆算 → 作るもの」。14 文字以内。この範囲で多くても 1 つ・無くてよい）。",
  "書き言葉で、体言止めや言い切りを使う。「〜ですね」「〜なんですけど」は使わない。数字は算用数字。",
  "from と to は、そのテロップが要約している行の番号（from ≦ to）。番号の若い順に並べ、範囲を重ねない。",
  "絶対に守ること：人の名前・あだ名・会社名・「〜さん」の呼び方を書かない。",
  '答えは JSON だけ：{"telops":[{"from":番号,"to":番号,"type":"A","text":"…"}]}',
].join("\n");

/** 第55版：テロップの量（less／normal／more）。normal は第54版の量 */
const DENSITY: Record<string, string> = {
  less: "量：少なめ。話の節目と大事なところだけに付け、間が空いてよい。",
  normal: "量：ふつう。",
  more: "量：多め。雑談と段取り以外はほぼ切れ目なく付け、1 つのテロップは 1〜2 行ぶんの話をまとめる。B と C も各 1 つまで積極的に使う。",
};

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/[\r\n\t]+/g, " ").replace(/[<>{}\\]/g, "").trim().slice(0, max) : "";
}

async function plan(env: ArchiveEnv, req: Request): Promise<Response> {
  const b = (await req.json()) as { lines?: [number, number, string][]; density?: string };
  const lines = (b.lines ?? []).slice(0, 120).filter((l) => Array.isArray(l) && Number.isFinite(l[0]));
  if (!lines.length) return json({ ok: true, telops: [] });
  if (!env.AI) return json({ ok: false, error: "AI の結びが無い" });
  const input = lines.map(([i, t, x]) => `[${i}] ${Math.round(Number(t))} ${String(x).slice(0, 300)}`).join("\n");
  let got: Record<string, unknown> | null = null;
  let why = "";
  for (let attempt = 0; attempt < 2 && !got; attempt++) {
    try {
      const res = await env.AI!.run(AI_MODEL as keyof AiModels, { instructions: PLAN_INSTRUCTIONS + "\n" + (DENSITY[b.density ?? ""] ?? DENSITY.normal), input, reasoning: { effort: "low" } } as never);
      got = parseJson(outputText(res));
      if (!got) why = "AI の答えが JSON で読めなかった";
    } catch (e) {
      why = `AI が答えなかった：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    }
  }
  if (!got) return json({ ok: false, error: why });
  const lo = lines[0][0];
  const hi = lines[lines.length - 1][0];
  const telops = (Array.isArray(got.telops) ? got.telops : [])
    .map((t) => t as { from?: unknown; to?: unknown; type?: unknown; text?: unknown })
    .map((t) => ({ from: Number(t.from), to: Number(t.to), type: ["A", "B", "C"].includes(String(t.type)) ? String(t.type) : "A", text: clean(t.text, 40) }))
    .filter((t) => t.text && Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= lo && t.to <= hi && t.from <= t.to);
  return json({ ok: true, telops });
}

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

/** 会の種類：棚の値 → 題名の「日付｜会｜話題」の真ん中 → その他 */
function kaiOf(src: Source): string {
  if (KAIS.includes(src.kai)) return src.kai;
  const mid = src.title.split("｜")[1] ?? "";
  return KAIS.includes(mid) ? mid : "その他";
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
  if (p === "/edit/plan" && req.method === "POST") return plan(env, req);
  if (p === "/edit/up-done" && req.method === "POST") {
    const r = (await uploadComplete(env, url.searchParams.get("u") ?? "")) as { ok?: boolean; id?: string };
    if (r.ok) {
      await refreshShelfItems(env);
      const src = await sourceOf(env, url.searchParams.get("id") ?? "");
      if (src && r.id) await metaSet(env, [{ id: r.id, kai: kaiOf(src), labels_add: ["自動編集"] }]);
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
    const b = (await req.json()) as { size?: number; ver?: string };
    const ver = clean(b.ver, 8);
    const title = `【編集版${ver ? " " + ver : ""}】${src.title.replace(/^\d{4}-\d{2}-\d{2}｜[^｜]*｜/, "") || src.date}`;
    return json(
      await uploadStart(env, {
        file_name: `edit_${src.id.slice(0, 12)}.mp4`,
        size: Number(b.size),
        date: src.date,
        title,
        kai: kaiOf(src),
        labels: ["自動編集"],
        by: "自動編集（edit.yml）",
      }),
    );
  }
  return json({ ok: false, error: "口が無い" }, 404);
}
