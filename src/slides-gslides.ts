/**
 * 第36版（2026-11-14 開発部・スライド制作 便4b）：スライドの台帳の配置表から Google スライドを作る。
 *
 * Naoki の理想の流れ ④「Google スライドに書き出す」⑤「Google スライド側で足しても直してもトーンが保たれる」のため。
 * 作る前の 1 枚に Naoki OK（2026-11-14 11:49）。
 *
 * - 呼ぶのは shia2n-mcp の slides__export_gslides（結び ZOOM_ARCHIVE の createSlidesDeck）。
 * - 配置表は 1920×1080 の座標。字は入力欄（Noto Sans JP）、薄い面と枠は四角、線と矢印は線、絵は画像として置く。
 *   字の無い絵・素材・描いた PNG の住所は、どれも外から読める https（shia2n-mcp の /slides/img/ と Supabase の公開の置き場）。
 * - 書く許可は、ドライブへ録画を置くのと同じ「ふだんの Google アカウント」の許可（drive.file）。
 *   Google スライドの道具は drive.file で、この仕組みが作ったファイルを読み書きできる。許可のやり直しは要らない。
 * - 第37版（2026-11-14）：枚の番号を p001 → slide_001 に（Google の決まりで 5 字以上・1 回目の書き出しで断られた）。途中で断られたら作りかけはゴミ箱へ
 * - 置き場はドライブの「スライド」フォルダ（この仕組みが作ったもの）。書き出すたびに新しいファイルを作り、前のものは消さない。
 */
import { findOrMakeFolder, g, token, type ContentDriveEnv } from "./content-drive";

const FOLDER_KEY = "slides-drive/root.json";
const FOLDER_NAME = "スライド";
const EMU = 9144000 / 1920; // 1px（1920 幅）あたりの EMU
const PT = 720 / 1920; // 1px あたりの pt
const FONT = "Noto Sans JP";

type Run = { text: string; color?: string; weight?: number };
export type Item =
  | { type: "text"; x: number; y: number; w: number; h: number; text?: string; runs?: Run[]; size: number; weight?: number; color?: string; align?: "left" | "center" | "right"; valign?: "top" | "middle" | "bottom"; line?: number }
  | { type: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; stroke_w?: number }
  | { type: "line"; x: number; y: number; w: number; h: number; color?: string; stroke_w?: number; arrow?: boolean }
  | { type: "image"; x: number; y: number; w: number; h: number; url?: string };

export interface CreateSlidesDeckInput {
  title: string;
  slides: { items: Item[] }[];
  templates?: { items: Item[] }[];
}

const rgb = (hex?: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "#192731");
  const [r, gr, b] = m ? [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255) : [0.098, 0.153, 0.192];
  return { opaqueColor: { rgbColor: { red: r, green: gr, blue: b } } };
};
const emu = (px: number) => Math.max(1, Math.round(px * EMU));
const box = (page: string, it: { x: number; y: number; w: number; h: number }) => ({
  pageObjectId: page,
  size: { width: { magnitude: emu(it.w), unit: "EMU" }, height: { magnitude: emu(it.h), unit: "EMU" } },
  transform: { scaleX: 1, scaleY: 1, translateX: Math.round(it.x * EMU), translateY: Math.round(it.y * EMU), unit: "EMU" },
});
const textStyle = (size: number, weight?: number, color?: string) => ({
  weightedFontFamily: { fontFamily: FONT, weight: Math.min(900, Math.max(100, Math.round((weight || 500) / 100) * 100)) },
  fontSize: { magnitude: Math.round(size * PT * 10) / 10, unit: "PT" },
  foregroundColor: rgb(color),
});

/** 1 枚分の Google スライドの道具への指示（中身だけ・試験しやすいように通信しない） */
export function slideRequests(page: string, items: Item[]): object[] {
  const req: object[] = [{ createSlide: { objectId: page, slideLayoutReference: { predefinedLayout: "BLANK" } } }];
  items.forEach((it, j) => {
    const id = `${page}_${j}`;
    if (it.type === "rect") {
      req.push({ createShape: { objectId: id, shapeType: "RECTANGLE", elementProperties: box(page, it) } });
      req.push({ updateShapeProperties: { objectId: id, fields: "shapeBackgroundFill,outline", shapeProperties: {
        shapeBackgroundFill: it.fill ? { solidFill: { color: rgb(it.fill).opaqueColor } } : { propertyState: "NOT_RENDERED" },
        outline: it.stroke ? { outlineFill: { solidFill: { color: rgb(it.stroke).opaqueColor } }, weight: { magnitude: Math.max(0.25, (it.stroke_w || 2) * PT), unit: "PT" } } : { propertyState: "NOT_RENDERED" },
      } } });
    } else if (it.type === "line") {
      req.push({ createLine: { objectId: id, lineCategory: "STRAIGHT", elementProperties: box(page, it) } });
      req.push({ updateLineProperties: { objectId: id, fields: "lineFill,weight,endArrow", lineProperties: {
        lineFill: { solidFill: { color: rgb(it.color).opaqueColor } }, weight: { magnitude: Math.max(0.25, (it.stroke_w || 4) * PT), unit: "PT" }, endArrow: it.arrow ? "FILL_ARROW" : "NONE",
      } } });
    } else if (it.type === "image") {
      if (it.url) req.push({ createImage: { objectId: id, url: it.url, elementProperties: box(page, it) } });
    } else {
      const runs: Run[] = it.runs && it.runs.length ? it.runs : [{ text: it.text || "" }];
      const all = runs.map(r => r.text).join("");
      if (!all) return;
      req.push({ createShape: { objectId: id, shapeType: "TEXT_BOX", elementProperties: box(page, it) } });
      req.push({ updateShapeProperties: { objectId: id, fields: "contentAlignment", shapeProperties: { contentAlignment: it.valign === "middle" ? "MIDDLE" : it.valign === "bottom" ? "BOTTOM" : "TOP" } } });
      req.push({ insertText: { objectId: id, insertionIndex: 0, text: all } });
      req.push({ updateTextStyle: { objectId: id, textRange: { type: "ALL" }, fields: "weightedFontFamily,fontSize,foregroundColor", style: textStyle(it.size, it.weight, it.color) } });
      let at = 0;
      for (const r of runs) {
        const len = r.text.length; // Google スライドの位置は UTF-16 の数（JS の length と同じ）
        if (len && (r.color || r.weight)) {
          req.push({ updateTextStyle: { objectId: id, textRange: { type: "FIXED_RANGE", startIndex: at, endIndex: at + len }, fields: "weightedFontFamily,foregroundColor", style: textStyle(it.size, r.weight ?? it.weight, r.color ?? it.color) } });
        }
        at += len;
      }
      req.push({ updateParagraphStyle: { objectId: id, textRange: { type: "ALL" }, fields: "alignment,lineSpacing", style: { alignment: it.align === "center" ? "CENTER" : it.align === "right" ? "END" : "START", lineSpacing: Math.round((it.line || 1.35) * 100) } } });
    }
  });
  return req;
}

async function slidesFolder(env: ContentDriveEnv, tk: string): Promise<string> {
  const o = await env.STORE.get(FOLDER_KEY);
  if (o) {
    const { id } = JSON.parse(await o.text()) as { id: string };
    try {
      const f = await g<{ trashed?: boolean }>(tk, `https://www.googleapis.com/drive/v3/files/${id}?fields=trashed`);
      if (!f.trashed) return id;
    } catch { /* 消されていたら作り直す */ }
  }
  const id = await findOrMakeFolder(tk, FOLDER_NAME, null);
  await env.STORE.put(FOLDER_KEY, JSON.stringify({ id }));
  return id;
}

export async function createSlidesDeck(env: ContentDriveEnv, input: CreateSlidesDeckInput): Promise<object> {
  try {
    const slides = [...(input.slides || []), ...(input.templates || [])];
    if (!slides.length) return { ok: false, error: "書き出す枚がありません" };
    if (slides.length > 200) return { ok: false, error: "200 枚を超えています" };
    const tk = await token(env);
    const made = await g<{ presentationId: string; slides?: { objectId: string }[] }>(tk, "https://slides.googleapis.com/v1/presentations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: String(input.title || "スライド").slice(0, 200), pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } } }),
    });
    const pid = made.presentationId;
    const blank = (made.slides || []).map(s => s.objectId);
    // 5 枚ずつ送る（1 回の指示が多すぎると断られるため）。途中で断られたら、作りかけのファイルはゴミ箱へ移す（第37版）
    try {
      for (let i = 0; i < slides.length; i += 5) {
        const requests = slides.slice(i, i + 5).flatMap((s, k) => slideRequests(`slide_${String(i + k + 1).padStart(3, "0")}`, s.items || []));
        await g(tk, `https://slides.googleapis.com/v1/presentations/${pid}:batchUpdate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }) });
      }
    } catch (e) {
      await g(tk, `https://www.googleapis.com/drive/v3/files/${pid}?fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) }).catch(() => undefined);
      throw e;
    }
    if (blank.length) {
      await g(tk, `https://slides.googleapis.com/v1/presentations/${pid}:batchUpdate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: blank.map(objectId => ({ deleteObject: { objectId } })) }) });
    }
    const folder = await slidesFolder(env, tk);
    const cur = await g<{ parents?: string[] }>(tk, `https://www.googleapis.com/drive/v3/files/${pid}?fields=parents`);
    await g(tk, `https://www.googleapis.com/drive/v3/files/${pid}?addParents=${folder}${cur.parents?.length ? `&removeParents=${cur.parents.join(",")}` : ""}&fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    return { ok: true, url: `https://docs.google.com/presentation/d/${pid}/edit`, slides: slides.length };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e).slice(0, 500) };
  }
}
