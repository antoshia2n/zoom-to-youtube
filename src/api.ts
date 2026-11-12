/**
 * zoom-to-youtube / api.ts（第21版・2026-11-02 開発部・経理系の依頼 1 便 4）
 *
 * shia2n-mcp から結び（services）で呼ぶ口 ArchiveApi。公開の住所には出ていないので、合言葉は要らない。
 *   list    一覧。既定は数と失敗だけ（全部の行は include_rows のときだけ。533 行・約 21 万字で重いため）
 *   search  探す。日付・会の名前・題名の言葉・大きさ・YouTube の有無・文字起こしの中の言葉で絞り、多くても 50 件
 *   remove  R2 から消す。confirm が true でなければ下見だけを返す（消さない）
 *   第28版（便 2 録画の棚・マーケくんの「録画」から呼ぶ）
 *   shelf        棚の一覧（全部の録画・共有の状態・整理の案・点検）
 *   share_issue  共有リンクを出す（すでにあればそれを返す）
 *   share_set    共有を止める・期限
 *   meta_set     名前と会の種類（まとめて）
 *   suggest_kai  「その他」の録画に会の種類の案を AI で付ける（少しずつ。5 分ごとの処理も 6 本ずつ出す）
 *   labels_edit  ラベルの名前を変える・削除（便 A）
 *   第32版（便 C 手で上げる・2026-11-06 Naoki OK 19:47）
 *   upload_start・upload_part・upload_complete・upload_abort  動画・音声を 16MB ずつ R2 へ入れ、棚に「アップロード」で並べる（src/upload.ts）
 *
 * 決め（2026-11-02 Naoki OK の便 4）
 *   ・消すかどうかは毎回 Naoki が決める。自動で消す仕組みは作らない
 *   ・R2 には消したものを戻す仕組みが無いので、下見 → 確定の 2 段を外さない
 *   ・YouTube には触らない。Zoom に残っていれば、次の実行で Zoom のゴミ箱へ移す（要らないと決めた録画なので）
 *   ・R2 へまだ入っていない古い録画も消せる（R2 へは入れず、Zoom のゴミ箱へ移すだけになる）
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { buildArchiveList, readSheetFailures, type ArchiveEnv, type ArchiveListResult, type ArchiveRow } from "./archive";
import { recKey, type LegacyRec } from "./legacy";
import { labelsEdit, memberData, memberInfo, memberPage, memberStream, memberVideo, metaSet, refreshShelfItems, routeConfig, routeConfigSet, routeDone, routeSet, shareIssue, shareSet, shelfList, suggestKai } from "./shelf";
import { saveContentImages, type ContentDriveEnv, type SaveContentImagesInput } from "./content-drive";
import { uploadAbort, uploadComplete, uploadPart, uploadStart } from "./upload";

export interface SearchQuery {
  date_from?: string;
  date_to?: string;
  kai?: string;
  words?: string;
  transcript_words?: string;
  min_gb?: number;
  max_gb?: number;
  youtube?: boolean;
  kind?: "new" | "legacy";
  zoom_deleted?: boolean;
  include_r2_deleted?: boolean;
  sort?: "date_desc" | "date_asc" | "size_desc";
  limit?: number;
}

const MAX_LIMIT = 50;
/** 文字起こしを開いて読む上限（それ以上は、ほかの条件で先に絞ってもらう） */
const MAX_TRANSCRIPT_READS = 300;

function plainVtt(vtt: string): string {
  return vtt
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !l.includes("-->"))
    .join(" ");
}

function snippet(text: string, word: string): string {
  const i = text.indexOf(word);
  if (i < 0) return "";
  return (i > 40 ? "…" : "") + text.slice(Math.max(0, i - 40), i + word.length + 60) + "…";
}

function jobKey(recId: string): string {
  return "job/" + recId.replace(/[^A-Za-z0-9._-]/g, "_") + ".json";
}

interface JobLike {
  recId: string;
  date?: string;
  title?: string;
  size?: number;
  r2Key?: string;
  r2Done?: boolean;
  r2VttDone?: boolean;
  youtubeUrl?: string;
  zoomDeletedAt?: string;
  r2DeletedAt?: string;
  naming?: { title?: string };
  updatedAt?: string;
}

export class ArchiveApi extends WorkerEntrypoint<ArchiveEnv> {
  async list(opts?: { include_rows?: boolean }): Promise<ArchiveListResult & { rows_note?: string }> {
    const r = await buildArchiveList(this.env, () => readSheetFailures(this.env));
    if (opts?.include_rows) return r;
    const { rows: _rows, ...rest } = r;
    void _rows;
    return { ...rest, rows_note: "行は省いた。録画を探すときは zoom_archive__search を使う（全部の行は include_rows: true）" };
  }

  async search(q: SearchQuery): Promise<object> {
    const all = (await buildArchiveList(this.env, async () => [])).rows ?? [];
    const words = (q.words ?? "").split(/[\s　]+/).filter(Boolean);
    const tWords = (q.transcript_words ?? "").split(/[\s　]+/).filter(Boolean);
    let rows = all.filter((r: ArchiveRow) => {
      if (!q.include_r2_deleted && r.r2_deleted_at) return false;
      if (q.date_from && r.date < q.date_from) return false;
      if (q.date_to && r.date > q.date_to) return false;
      if (q.kai && r.kai !== q.kai) return false;
      if (q.kind && r.kind !== q.kind) return false;
      if (q.youtube !== undefined && r.youtube !== q.youtube) return false;
      if (q.zoom_deleted !== undefined && r.zoom_deleted !== q.zoom_deleted) return false;
      if (q.min_gb !== undefined && (r.size_gb ?? 0) < q.min_gb) return false;
      if (q.max_gb !== undefined && (r.size_gb ?? 0) > q.max_gb) return false;
      if (words.length && !words.every((w) => r.title.includes(w))) return false;
      return true;
    });

    const hits = new Map<string, string>();
    let notRead = 0;
    if (tWords.length) {
      const keep: ArchiveRow[] = [];
      let reads = 0;
      for (const r of rows) {
        if (!r.r2_key) continue; // R2 に文字起こしが無いものは中身で探せない
        if (reads >= MAX_TRANSCRIPT_READS) {
          notRead++;
          continue;
        }
        reads++;
        const o = await this.env.STORE.get(r.r2_key.replace(/\.mp4$/, ".vtt"));
        if (!o) continue;
        const text = plainVtt(await o.text());
        if (tWords.every((w) => text.includes(w))) {
          keep.push(r);
          hits.set(r.rec_id, snippet(text, tWords[0]));
        }
      }
      rows = keep;
    }

    const sort = q.sort ?? "date_desc";
    rows.sort((a, b) =>
      sort === "size_desc" ? (b.size_gb ?? 0) - (a.size_gb ?? 0) : sort === "date_asc" ? (a.date < b.date ? -1 : 1) : a.date < b.date ? 1 : -1,
    );
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? 20)));
    const picked = rows.slice(0, limit).map((r) => ({
      rec_id: r.rec_id,
      date: r.date,
      kai: r.kai,
      title: r.title,
      size_gb: r.size_gb,
      kind: r.kind,
      r2: r.r2,
      youtube: r.youtube,
      zoom_deleted: r.zoom_deleted,
      naming: r.naming,
      ...(hits.has(r.rec_id) ? { transcript_hit: hits.get(r.rec_id) } : {}),
    }));
    return {
      ok: true,
      matched: rows.length,
      returned: picked.length,
      total_gb: Math.round(rows.reduce((a, r) => a + (r.size_gb ?? 0), 0) * 100) / 100,
      rows: picked,
      ...(notRead ? { transcript_not_read: notRead, note: `文字起こしを読んだのは ${MAX_TRANSCRIPT_READS} 本まで。ほかの条件で先に絞ると残りも探せる` } : {}),
    };
  }

  async shelf(): Promise<object> {
    return shelfList(this.env);
  }

  async share_issue(id: string): Promise<object> {
    return shareIssue(this.env, id);
  }

  async share_set(id: string, opts: { stopped?: boolean; expires?: string | null }): Promise<object> {
    return shareSet(this.env, id, opts ?? {});
  }

  /** 第33版：出し先のスイッチ（YouTube・会員サイト・入れるコース） */
  async route_set(id: string, opts: { youtube?: boolean; site?: boolean; course_id?: string | null; reset?: boolean }): Promise<object> {
    return routeSet(this.env, id, opts ?? {});
  }

  /** 第33版：会の種類ごとの入れ先のコース */
  async route_config(): Promise<object> {
    return routeConfig(this.env);
  }

  async route_config_set(courses: Record<string, string | null>): Promise<object> {
    return routeConfigSet(this.env, courses ?? {});
  }

  /** 第33版：マーケくんが会員サイトに入れ終えた印 */
  async route_done(id: string, contentId: string): Promise<object> {
    return routeDone(this.env, id, contentId);
  }

  async labels_edit(opts: { action: "rename" | "delete"; from: string; to?: string }): Promise<object> {
    return labelsEdit(this.env, opts ?? { action: "delete", from: "" });
  }

  async meta_set(list: { id: string; title?: string; kai?: string; labels_add?: string[]; labels_remove?: string[] }[]): Promise<object> {
    return metaSet(this.env, Array.isArray(list) ? list : []);
  }

  /** 会員サイトの見る画面（第30版）。呼ぶ側がログインと権利を確かめてから */
  async member_page(id: string, videoSrc: string, title?: string): Promise<object> {
    return memberPage(this.env, id, videoSrc, title);
  }

  /** 第31版：会員サイトの見る画面に渡す中身（文字起こし・目次・要約・映像の置き場） */
  async member_data(id: string): Promise<object> {
    return memberData(this.env, id);
  }

  /** 第31版：置き場を指して流す（マーケくんが合言葉で確かめた置き場だけを渡す） */
  async member_stream(key: string, range?: string | null, method?: string): Promise<Response> {
    return memberStream(this.env, key, range, method);
  }

  /** 会員サイトに入れるときに写す中身（名前・要約・目次・長さ） */
  async member_info(id: string): Promise<object> {
    return memberInfo(this.env, id);
  }

  /** 会員サイトの映像（Range つき）。呼ぶ側がログインと権利を確かめてから */
  async member_video(id: string, range?: string | null, method?: string): Promise<Response> {
    return memberVideo(this.env, id, range, method);
  }

  /** 第32版（便 C）：手で上げる。マーケくんがログインを確かめてから呼ぶ */
  async upload_start(b: { file_name?: string; size?: number; date?: string; title?: string; kai?: string; labels?: string[]; by?: string }): Promise<object> {
    return uploadStart(this.env, b ?? {});
  }

  async upload_part(id: string, partNumber: number, body: ReadableStream | ArrayBuffer | null): Promise<object> {
    return uploadPart(this.env, id, partNumber, body);
  }

  async upload_complete(id: string): Promise<object> {
    const r = (await uploadComplete(this.env, id)) as { ok?: boolean; id?: string };
    if (!r.ok) return r;
    // 棚の元を作り直す（5 分ごとの処理を待たずに棚に出す）。ラベルは名前と同じく棚の上書きに入れる
    await refreshShelfItems(this.env);
    const rec = await this.env.STORE.get("upload/rec/" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
    const labels = rec ? ((JSON.parse(await rec.text()) as { labels?: string[] }).labels ?? []) : [];
    if (labels.length) await metaSet(this.env, [{ id: String(r.id), labels_add: labels }]);
    return r;
  }

  async upload_abort(id: string): Promise<object> {
    return uploadAbort(this.env, id);
  }

  async suggest_kai(limit?: number): Promise<object> {
    return suggestKai(this.env, limit ?? 8);
  }

  /** 第27版：コンテンツくんの依頼の画像を、ドライブの「コンテンツくん/月/日付_題/種類/」へ写す（shia2n-mcp の content_os__put_result から呼ぶ） */
  async saveContentImages(input: SaveContentImagesInput): Promise<object> {
    return saveContentImages(this.env as unknown as ContentDriveEnv, input);
  }

  async remove(recId: string, confirm: boolean): Promise<object> {
    const id = String(recId ?? "").trim();
    if (!id) return { ok: false, error: "rec_id が空です" };

    // 第32版：手で上げたもの（up_ で始まる）。下見 → 確定の 2 段は同じ
    if (id.startsWith("up_")) {
      const uk = "upload/rec/" + id.replace(/[^A-Za-z0-9_-]/g, "_") + ".json";
      const uo = await this.env.STORE.get(uk);
      if (!uo) return { ok: false, error: "not_found" };
      const u = JSON.parse(await uo.text()) as { r2Key: string; date: string; title: string; state: string };
      const h = await this.env.STORE.head(u.r2Key);
      const gb = h ? Math.round((h.size / 1073741824) * 100) / 100 : 0;
      if (!confirm) return { ok: true, mode: "preview", rec_id: id, kind: "upload", date: u.date, title: u.title, total_gb: gb, will_do: [h ? `R2 から 1 個（${gb} GB）を消す。戻せない` : "R2 にファイルが無い（控えだけ消す）"], note: "消すときは同じ rec_id で confirm: true を付けて呼び直す" };
      if (h) await this.env.STORE.delete(u.r2Key);
      await this.env.STORE.delete(uk);
      await refreshShelfItems(this.env);
      const left = !!(await this.env.STORE.head(u.r2Key));
      return { ok: !left, mode: "deleted", rec_id: id, kind: "upload", left_in_r2: left ? [u.r2Key] : [] };
    }
    // 古い録画（会議の番号）→ 新しい録画（台帳の控え）の順に探す
    const lo = await this.env.STORE.get(recKey(id));
    let kind: "legacy" | "new";
    let rec: LegacyRec | null = null;
    let job: JobLike | null = null;
    if (lo) {
      kind = "legacy";
      rec = JSON.parse(await lo.text()) as LegacyRec;
    } else {
      const jo = await this.env.STORE.get(jobKey(id));
      if (!jo) return { ok: false, error: "not_found", note: "rec_id は zoom_archive__search の rec_id をそのまま渡す" };
      kind = "new";
      job = JSON.parse(await jo.text()) as JobLike;
    }

    const keys =
      kind === "legacy"
        ? (rec as LegacyRec).files.map((f) => f.r2Key).filter((k): k is string => !!k)
        : [job?.r2Key, job?.r2Key?.replace(/\.mp4$/, ".vtt")].filter((k): k is string => !!k);
    const files: { key: string; size_mb: number }[] = [];
    for (const k of [...new Set(keys)]) {
      const h = await this.env.STORE.head(k);
      if (h) files.push({ key: k, size_mb: Math.round((h.size / 1048576) * 10) / 10 });
    }
    const already = kind === "legacy" ? rec?.r2DeletedAt : job?.r2DeletedAt;
    const zoomDeleted = !!(kind === "legacy" ? rec?.zoomDeletedAt : job?.zoomDeletedAt);
    const summary = {
      rec_id: id,
      kind,
      date: kind === "legacy" ? rec?.date : job?.date,
      title: kind === "legacy" ? (rec?.match?.title ?? rec?.naming?.title ?? "") : (job?.naming?.title ?? job?.title ?? ""),
      files,
      total_gb: Math.round((files.reduce((a, f) => a + f.size_mb, 0) / 1024) * 100) / 100,
      youtube: !!(kind === "legacy" ? rec?.match?.youtubeUrl : job?.youtubeUrl),
      zoom_deleted: zoomDeleted,
      already_r2_deleted_at: already ?? null,
    };

    if (!confirm) {
      return {
        ok: true,
        mode: "preview",
        ...summary,
        will_do: [
          files.length ? `R2 から ${files.length} 個（${summary.total_gb} GB）を消す。戻せない` : "R2 にはまだ入っていない（R2 へは入れなくなる）",
          "YouTube には触らない",
          zoomDeleted ? "Zoom ではゴミ箱へ移し済み" : "Zoom に残っている分は、次の実行で Zoom のゴミ箱へ移す（30 日は戻せる）",
        ],
        note: "消すときは同じ rec_id で confirm: true を付けて呼び直す",
      };
    }

    if (files.length) await this.env.STORE.delete(files.map((f) => f.key));
    const now = new Date().toISOString();
    if (kind === "legacy" && rec) {
      rec.r2DeletedAt = now;
      rec.updatedAt = now;
      await this.env.STORE.put(recKey(id), JSON.stringify(rec));
    } else if (job) {
      job.r2DeletedAt = now;
      job.updatedAt = now;
      await this.env.STORE.put(jobKey(id), JSON.stringify(job));
    }
    // 消えたかを取り直して確かめる
    const left: string[] = [];
    for (const f of files) if (await this.env.STORE.head(f.key)) left.push(f.key);
    return { ok: left.length === 0, mode: "deleted", ...summary, r2_deleted_at: now, left_in_r2: left };
  }
}
