/**
 * zoom-to-youtube / purge.ts（第20版・第22版で大きさの合わないファイルの入れ直しを足した・2026-11-02 開発部・経理系の依頼 1 便 3）
 *
 * R2 と YouTube の両方にそろった録画だけを、Zoom のゴミ箱へ移す（消すのではなく trash。30 日は Zoom 側で戻せる）。
 *
 * 消す前に毎回、実物で確かめる（控えの印だけを信じない）
 *   ・R2：その会議のファイルが全部あり、大きさが Zoom の大きさと同じ
 *   ・YouTube：動画があり、取り込みが終わっている（uploadStatus が processed）
 * 1 つでも合わなければ消さずに、理由を控えに残す。
 *
 * 11/02 より前の録画で YouTube と結び付かなかったものは、LEGACY_R2_ONLY_BEFORE（2025-01-01）より前に録ったものだけ R2 だけで消す
 * （依頼の決めは「原本が 2 か所にそろうまで消さない」。変えるのは Naoki の判断で）。
 */
import { zoomToken, type ArchiveEnv } from "./archive";
import { legacyRows, recKey, type LegacyRec } from "./legacy";

/**
 * YouTube と結び付かない古い録画を、R2 だけで Zoom から消してよい境目（この日より前に録ったもの）。
 * 2026-11-02 14:39 Naoki「古い動画はだいたい不要で、新しく取り直すものも多い。過去に一度YouTubeに写してあるから大丈夫」
 * 2026-11-02 14:46 Naoki「古いの基準は2024年以前ね。25年あたりのは使う可能性がある」→ 2025-01-01 より前だけ。
 * 2026-11-02 20:59 第23版：Naoki「OK、進めて」（2025 年以降も文字起こしで中身を探せ、原本は R2 に残るので、R2 だけで消してよい）
 * → 11/02 より前の録画は全部、R2 にそろえば Zoom のゴミ箱へ。境目は古い録画の終わり（2026-11-02）。
 * 2025 年以降で YouTube と結び付かない録画は、R2 にそろっても Zoom に残す。
 * 対象は R2 に全部入り終えて大きさを確かめたものだけで、Zoom ではゴミ箱へ移す（30 日は戻せる）
 */
export const LEGACY_R2_ONLY_BEFORE = "2026-11-02";
/** 1 回の実行で Zoom のゴミ箱へ移す上限 */
const PER_RUN = 30;

function uuidPath(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

function videoId(url: string | undefined): string | null {
  const m = (url ?? "").match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

interface JobLike {
  recId: string;
  meetingUuid?: string;
  r2Key?: string;
  r2Done?: boolean;
  size?: number;
  youtubeUrl?: string;
  zoomDeletedAt?: string;
  r2DeletedAt?: string;
  lastError?: string;
  date?: string;
  updatedAt?: string;
}

interface Candidate {
  label: string;
  uuid: string;
  youtube: string | null;
  r2: { key: string; size: number }[];
  r2Only: boolean;
  /** 第21版：探す・消す道具で「要らない」と決めて R2 から消した録画。確かめずに Zoom のゴミ箱へ移す */
  discarded?: boolean;
  mark: (at: string | null, err: string | null) => Promise<void>;
  /**
   * 第22版：R2 の大きさが合わないファイルを、Zoom からもう一度入れ直すように戻す（古い録画だけ）。
   * 置き場は新しい名前にする（合わないファイルが別の録画のものだった場合に上書きしないため）。
   */
  recopy?: (key: string) => Promise<string | null>;
}

/** YouTube の動画の取り込みが終わっているかを 50 本ずつ聞く */
async function youtubeReady(ids: string[], token: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${ids.slice(i, i + 50).join(",")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`YouTube に動画の状態を聞けません（${r.status}）`);
    const b = (await r.json()) as { items?: { id?: string; status?: { uploadStatus?: string } }[] };
    for (const it of b.items ?? []) if (it.id) out.set(it.id, it.status?.uploadStatus ?? "");
  }
  return out;
}

export interface PurgeResult {
  trashed: number;
  waiting: number;
  blocked: string[];
  error?: string;
}

/**
 * 消してよい録画を Zoom のゴミ箱へ移す。1 回 PER_RUN 本まで。
 * 返す waiting は「R2 か YouTube がまだそろっていないので待っている」本数（R2 だけで消せない古い録画を含む）。
 */
export async function purgeZoom(
  env: ArchiveEnv,
  ytToken: () => Promise<string>,
  out: (s: string) => void,
): Promise<PurgeResult> {
  const res: PurgeResult = { trashed: 0, waiting: 0, blocked: [] };
  try {
    const cands: Candidate[] = [];

    // 11/02 以降の録画（台帳から流れたもの）
    let cursor: string | undefined;
    for (let g = 0; g < 50; g++) {
      const page = await env.STORE.list({ prefix: "job/", cursor });
      for (const o of page.objects) {
        const got = await env.STORE.get(o.key);
        if (!got) continue;
        const j = JSON.parse(await got.text()) as JobLike;
        if (!j.meetingUuid || j.zoomDeletedAt) continue;
        const discarded = !!j.r2DeletedAt;
        if (!discarded && (!j.r2Done || !j.youtubeUrl || !j.r2Key || !j.size)) {
          res.waiting++;
          continue;
        }
        cands.push({
          label: `${j.date ?? ""}（新しい録画）`,
          uuid: j.meetingUuid,
          youtube: videoId(j.youtubeUrl),
          r2: j.r2Key ? [{ key: j.r2Key, size: j.size ?? 0 }] : [],
          r2Only: false,
          discarded,
          mark: async (at, err) => {
            if (at) j.zoomDeletedAt = at;
            j.lastError = err ?? undefined;
            j.updatedAt = new Date().toISOString();
            await env.STORE.put(o.key, JSON.stringify(j));
          },
        });
      }
      if (!page.truncated) break;
      cursor = page.cursor;
    }

    // 11/02 より前の録画（便 2 で R2 へ移したもの）
    for (const r of await legacyRows(env)) {
      if (r.zoomDeletedAt) continue;
      const yt = r.match?.youtubeUrl;
      const r2OnlyOk = r.date < LEGACY_R2_ONLY_BEFORE;
      const discarded = !!r.r2DeletedAt;
      if (!discarded && (!r.r2Done || (!yt && !r2OnlyOk))) {
        res.waiting++;
        continue;
      }
      const rec: LegacyRec = r;
      cands.push({
        label: `${r.date}（古い録画）`,
        uuid: r.uuid,
        youtube: videoId(yt),
        r2: r.files.filter((f) => f.r2Key).map((f) => ({ key: f.r2Key as string, size: f.size })),
        r2Only: !yt,
        discarded,
        mark: async (at, err) => {
          if (at) rec.zoomDeletedAt = at;
          rec.lastError = err ?? undefined;
          rec.updatedAt = new Date().toISOString();
          await env.STORE.put(recKey(rec.uuid), JSON.stringify(rec));
        },
        recopy: async (key) => {
          const f = rec.files.find((x) => x.r2Key === key);
          if (!f) return null;
          const dot = key.lastIndexOf(".");
          const stem = dot > 0 ? key.slice(0, dot) : key;
          const ext = dot > 0 ? key.slice(dot) : "";
          let next = "";
          for (let n = 1; n < 50; n++) {
            const k = `${stem}_re${n === 1 ? "" : n}${ext}`;
            if (!(await env.STORE.head(k))) {
              next = k;
              break;
            }
          }
          if (!next) return null;
          f.r2Key = next;
          f.r2Done = false;
          f.r2UploadId = undefined;
          f.r2Parts = undefined;
          f.forceStream = undefined;
          rec.r2Done = false;
          rec.updatedAt = new Date().toISOString();
          await env.STORE.put(recKey(rec.uuid), JSON.stringify(rec));
          return next;
        },
      });
    }

    if (!cands.length) return res;
    const pick = cands.slice(0, PER_RUN);
    res.waiting += cands.length - pick.length;

    const ids = pick.filter((c) => !c.discarded).map((c) => c.youtube).filter((x): x is string => !!x);
    const ready = ids.length ? await youtubeReady(ids, await ytToken()) : new Map<string, string>();
    const token = await zoomToken(env);

    for (const c of pick) {
      // R2 の実物を確かめる
      let why = "";
      let badKey = "";
      if (c.discarded) {
        // 要らないと決めた録画：R2 と YouTube は確かめない
      } else if (!c.r2.length) why = "R2 のファイルの控えが無い";
      for (const f of c.discarded ? [] : c.r2) {
        if (why) break;
        const h = await env.STORE.head(f.key);
        if (!h) why = `R2 にファイルが無い（${f.key}）`;
        else if (f.size > 0 && h.size !== f.size) {
          why = `R2 の大きさが合わない（${f.key}）`;
          badKey = f.key;
        }
      }
      // YouTube の実物を確かめる（R2 だけで消してよい古い録画は見ない）
      if (!why && !c.r2Only && !c.discarded) {
        const st = c.youtube ? ready.get(c.youtube) : undefined;
        if (!c.youtube || st === undefined) why = "YouTube に動画が見つからない";
        else if (st !== "processed") why = `YouTube の取り込みが終わっていない（${st || "不明"}）`;
      }
      if (why && badKey && c.recopy) {
        // 第22版：止めるだけだと、Zoom の 30 日の自動削除で R2 に正しい写しが無いまま消える。Zoom にあるうちに入れ直す
        const next = await c.recopy(badKey);
        if (next) {
          await c.mark(null, null);
          out(`  ${c.label}：R2 の大きさが合わないので、Zoom から入れ直す（${next}）`);
          continue;
        }
      }
      if (why) {
        await c.mark(null, `Zoom から消すのを止めた：${why}`);
        res.blocked.push(`${c.label}：${why}`);
        continue;
      }
      const del = await fetch(`https://api.zoom.us/v2/meetings/${uuidPath(c.uuid)}/recordings?action=trash`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      const raw = del.status === 204 ? "" : (await del.text()).slice(0, 300);
      if (del.status === 204 || del.status === 200) {
        await c.mark(new Date().toISOString(), null);
        res.trashed++;
        out(`  Zoom のゴミ箱へ移した：${c.label}`);
      } else if (del.status === 404 && raw.includes("3301")) {
        // Zoom 側にもう無い（手で消した・前の実行で移した）
        await c.mark(new Date().toISOString(), null);
        out(`  Zoom にはもう無かった：${c.label}`);
      } else {
        const err = `Zoom が消すのを断った（${del.status}／${raw}）`;
        await c.mark(null, err);
        res.blocked.push(`${c.label}：${err}`);
      }
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }
  return res;
}
