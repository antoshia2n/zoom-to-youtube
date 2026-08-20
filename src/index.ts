/**
 * zoom-to-youtube / 第2版（2026-08-20 開発部）
 *
 * この版でできること
 *   - Zoom の録画の情報を取る／動画の本体の転送を測る（/probe）
 *   - Google の許可を1回取って、その控えを置き場に保存する（/oauth/*）
 *
 * この版でまだできないこと
 *   - ドライブへの保存、YouTube への投稿、シートの読み書き（次の版）
 *
 * 置き場（R2 バケット zoom-to-youtube）に置く物
 *   auth/google.json     … 許可の控え（更新用の鍵・取得した日時・アカウント）
 *   auth/state/{値}      … 許可の途中で使う使い捨ての合言葉（受け取ったら消す）
 */

interface Env {
  STORE: R2Bucket;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_EMAIL?: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ZOOM_BASE = "https://us02web.zoom.us";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
].join(" ");

const AUTH_KEY = "auth/google.json";

interface StoredAuth {
  refresh_token: string;
  scope: string;
  email: string;
  obtained_at: string;
}

/* ------------------------------------------------------------------ */
/* 共通の小物                                                          */
/* ------------------------------------------------------------------ */

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** JWT の中身だけ取り出す（Google から直接受け取った物なので署名の検証はしない） */
function readIdToken(idToken: string): { email?: string; email_verified?: boolean } {
  const part = idToken.split(".")[1];
  if (!part) return {};
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function missingSetup(env: Env): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.ALLOWED_EMAIL) missing.push("ALLOWED_EMAIL");
  return missing;
}

/* ------------------------------------------------------------------ */
/* Google の許可                                                       */
/* ------------------------------------------------------------------ */

async function oauthStart(request: Request, env: Env): Promise<Response> {
  const missing = missingSetup(env);
  if (missing.length > 0) {
    return text(
      [
        "設定が足りません。Cloudflare の Workers の画面 → Settings → Variables and Secrets で、",
        "Type を Secret にして下の名前を入れてください。",
        "",
        ...missing.map((m) => "  ・" + m),
      ].join("\n"),
      500,
    );
  }

  const redirectUri = new URL("/oauth/callback", request.url).toString();
  const state = crypto.randomUUID();
  await env.STORE.put(`auth/state/${state}`, new Date().toISOString());

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID as string);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", GOOGLE_SCOPES);
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", state);

  return Response.redirect(auth.toString(), 302);
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const err = url.searchParams.get("error");
  if (err) {
    return text(
      [
        "Google 側で許可が出ませんでした。",
        "",
        `理由：${err}`,
        "",
        "「アクセスをブロック」と出た場合は、Google の Audience の画面で",
        "自分のアドレスが Test users に入っているかを見てください。",
      ].join("\n"),
      400,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return text("許可の受け取りに必要な値がありません。", 400);

  const held = await env.STORE.get(`auth/state/${state}`);
  if (!held) {
    return text(
      [
        "合言葉が合いませんでした。",
        "",
        "この画面を直接開いた場合や、時間が空きすぎた場合に出ます。",
        "/oauth/start からやり直してください。",
      ].join("\n"),
      400,
    );
  }
  await env.STORE.delete(`auth/state/${state}`);

  const redirectUri = new URL("/oauth/callback", request.url).toString();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const body = (await res.json()) as {
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    return text(
      [
        "Google との引き換えに失敗しました。",
        "",
        `種類：${body.error ?? res.status}`,
        `説明：${body.error_description ?? "なし"}`,
        "",
        "redirect_uri_mismatch と出た場合は、Google の Clients の画面に登録した住所が",
        "下の1本と1文字も違わないかを見てください。",
        `  ${redirectUri}`,
      ].join("\n"),
      400,
    );
  }

  if (!body.refresh_token) {
    return text(
      [
        "更新用の鍵が返りませんでした。",
        "",
        "同じアカウントで前に許可を出していると起きることがあります。",
        "https://myaccount.google.com/permissions で zoom-to-youtube のアクセスを取り消してから、",
        "/oauth/start をもう一度開いてください。",
      ].join("\n"),
      400,
    );
  }

  const claims = body.id_token ? readIdToken(body.id_token) : {};
  const email = (claims.email ?? "").toLowerCase();
  const allowed = (env.ALLOWED_EMAIL as string).trim().toLowerCase();

  if (!email || email !== allowed) {
    return text(
      [
        "このアカウントの許可は受け付けません。控えは保存していません。",
        "",
        `許可を出したアカウント：${email || "（取れませんでした）"}`,
        "受け付ける設定になっているアカウントとは別です。",
        "",
        "上げ先の YouTube チャンネルを持っているアカウントでやり直してください。",
      ].join("\n"),
      403,
    );
  }

  const stored: StoredAuth = {
    refresh_token: body.refresh_token,
    scope: body.scope ?? "",
    email,
    obtained_at: new Date().toISOString(),
  };
  await env.STORE.put(AUTH_KEY, JSON.stringify(stored));

  return text(
    [
      "許可を保存しました。ここで完了です。この画面は閉じて大丈夫です。",
      "",
      `アカウント：${email}`,
      `保存した日時：${stored.obtained_at}`,
      "",
      "取れた許可：",
      ...(stored.scope ? stored.scope.split(" ").map((s) => "  ・" + s) : ["  （表示なし）"]),
      "",
      "生きているかは /oauth/status で見られます。",
    ].join("\n"),
  );
}

/** 更新用の鍵から、使い捨ての鍵を1本作る（次の版の本処理でも使う） */
async function getAccessToken(env: Env): Promise<{ ok: true; token: string } | { ok: false; why: string }> {
  const obj = await env.STORE.get(AUTH_KEY);
  if (!obj) return { ok: false, why: "許可の控えがまだありません。/oauth/start から1回通してください。" };

  const saved = JSON.parse(await obj.text()) as StoredAuth;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      refresh_token: saved.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };

  if (!res.ok || !body.access_token) {
    return {
      ok: false,
      why:
        `${body.error ?? res.status}／${body.error_description ?? "説明なし"}` +
        (body.error === "invalid_grant"
          ? "（許可が切れています。/oauth/start からもう一度通してください）"
          : ""),
    };
  }
  return { ok: true, token: body.access_token };
}

async function oauthStatus(env: Env): Promise<Response> {
  const missing = missingSetup(env);
  const obj = await env.STORE.get(AUTH_KEY);

  const lines: string[] = ["--- 許可の状態 ---", ""];
  lines.push(`設定の3つ　　　${missing.length === 0 ? "そろっている" : "足りない：" + missing.join(", ")}`);

  if (!obj) {
    lines.push("控え　　　　　まだ無い");
    lines.push("");
    lines.push("/oauth/start を開いて、1回だけ許可を通してください。");
    return text(lines.join("\n"));
  }

  const saved = JSON.parse(await obj.text()) as StoredAuth;
  lines.push(`控え　　　　　ある（${saved.obtained_at} に保存）`);
  lines.push(`アカウント　　${saved.email}`);

  if (missing.length > 0) {
    return text(lines.join("\n"));
  }

  const t = await getAccessToken(env);
  lines.push(`いま使えるか　${t.ok ? "使える" : "使えない：" + t.why}`);
  lines.push("");
  lines.push("この画面に鍵そのものは表示しません。");
  return text(lines.join("\n"));
}

/* ------------------------------------------------------------------ */
/* Zoom の測定（第1版から変更なし）                                    */
/* ------------------------------------------------------------------ */

class Jar {
  private m = new Map<string, string>();

  absorb(res: Response): void {
    const h = res.headers as unknown as { getSetCookie?: () => string[] };
    const list = typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
    for (const raw of list) {
      const first = raw.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) this.m.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.m].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function zoomHeaders(jar: Jar, referer?: string, accept?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA };
  if (referer) h["Referer"] = referer;
  if (accept) h["Accept"] = accept;
  const ck = jar.header();
  if (ck) h["Cookie"] = ck;
  return h;
}

async function go(
  jar: Jar,
  url: string,
  referer?: string,
  accept?: string,
): Promise<{ res: Response; url: string }> {
  let cur = url;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(cur, { headers: zoomHeaders(jar, referer, accept), redirect: "manual" });
    jar.absorb(res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, url: cur };
      await res.body?.cancel();
      cur = new URL(loc, cur).toString();
      continue;
    }
    return { res, url: cur };
  }
  throw new Error("リダイレクトが 10 回を超えました");
}

async function runProbe(share: string, mode: string, out: (line: string) => void): Promise<void> {
  const jar = new Jar();
  const t0 = Date.now();

  out("【1】共有ページを開く");
  const a = await go(jar, share);
  if (a.res.status !== 200) throw new Error(`共有ページが ${a.res.status} を返しました`);
  const html = await a.res.text();
  const m = html.match(/meetingId:\s*'([^']+)'/);
  if (!m) throw new Error("共有ページに meetingId がありません。共有リンクが切れている可能性があります。");
  out(`      取れた（${sec(Date.now() - t0)} 秒）`);

  out("【2】再生ページの場所を聞く");
  const s = await go(jar, `${ZOOM_BASE}/nws/recording/1.0/play/share-info/${m[1]}`, share, "application/json");
  const sj = (await s.res.json()) as { status?: boolean; errorMessage?: string; result?: { redirectUrl?: string } };
  if (!sj.status || !sj.result?.redirectUrl) throw new Error(`share-info が失敗しました: ${sj.errorMessage ?? "理由なし"}`);
  const pid = sj.result.redirectUrl.split("/").filter(Boolean).pop() as string;
  const playUrl = ZOOM_BASE + sj.result.redirectUrl;
  out("      取れた");

  out("【3】再生ページを1回踏む");
  const p = await go(jar, playUrl, share);
  await p.res.body?.cancel();
  out(`      ${p.res.status}`);

  out("【4】録画の情報を取る");
  const i = await go(jar, `${ZOOM_BASE}/nws/recording/1.0/play/info/${pid}`, playUrl, "application/json");
  const ij = (await i.res.json()) as { status?: boolean; errorMessage?: string; result?: Record<string, unknown> };
  if (!ij.status || !ij.result) throw new Error(`info が失敗しました: ${ij.errorMessage ?? "理由なし"}`);

  const r = ij.result as {
    meet?: { topic?: string; meetingStartTimeStr?: string };
    fileStartTime?: number;
    duration?: number;
    recording?: { fileSizeInMB?: number };
    hasTranscript?: boolean;
    disableDownload?: boolean;
    transcriptUrl?: string;
    mp4Url?: string;
    xmppList?: unknown[];
  };
  const mp4Url = r.mp4Url;
  if (!mp4Url) throw new Error("mp4 の直リンクが info にありません");

  out("");
  out("--- 録画の中身 ---");
  out(`  題名          ${r.meet?.topic ?? "（なし）"}`);
  out(`  収録の日時    ${r.meet?.meetingStartTimeStr ?? "（なし）"}`);
  out(`  開始（機械用） ${r.fileStartTime ?? "（なし）"}`);
  out(`  長さ（秒）    ${r.duration ?? "（なし）"}`);
  out(`  申告サイズ    ${r.recording?.fileSizeInMB ?? "（なし）"}`);
  out(`  文字起こし    ${r.hasTranscript ? "あり" : "なし"}`);
  out(`  取得の禁止    ${r.disableDownload ? "オン（取れない）" : "オフ"}`);
  out(`  チャット      ${(r.xmppList ?? []).length} 件`);
  out(`  直リンクの元  ${new URL(mp4Url).hostname}`);
  out("");

  if (r.transcriptUrl) {
    out("【5】文字起こしを取る");
    const v = await go(jar, ZOOM_BASE + r.transcriptUrl, playUrl);
    const vtt = await v.res.text();
    out(`      ${vtt.length} 文字 / 区切り ${vtt.split("-->").length - 1} 個`);
    out("");
  }

  out("【6】途中から再開できるかを見る");
  const rng = await fetch(mp4Url, { headers: { ...zoomHeaders(jar, playUrl), Range: "bytes=0-99" } });
  await rng.body?.cancel();
  out(rng.status === 206 ? "      できる（206 が返った）" : `      できない（${rng.status} が返った）`);
  out("");

  if (mode !== "drain") {
    out(`ここまで ${sec(Date.now() - t0)} 秒。本体の転送は測っていません。`);
    return;
  }

  out("【7】動画の本体を読み切る（溜め込まずに捨てながら読む）");
  const tDl = Date.now();
  const dl = await fetch(mp4Url, { headers: zoomHeaders(jar, playUrl) });
  if (!dl.ok || !dl.body) throw new Error(`本体が ${dl.status} を返しました`);
  const declared = dl.headers.get("content-length");
  out(`      最初の1バイトまで ${sec(Date.now() - tDl)} 秒 / 申告 ${declared ?? "なし"} バイト`);

  const reader = dl.body.getReader();
  let bytes = 0;
  let lastReport = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (Date.now() - lastReport >= 5000) {
      out(`      ${mb(bytes)} MB / ${sec(Date.now() - tDl)} 秒`);
      lastReport = Date.now();
    }
  }
  const elapsed = Date.now() - tDl;

  out("");
  out("--- 結果 ---");
  out(`  読み切ったバイト数  ${bytes}（${mb(bytes)} MB）`);
  out(`  かかった時間        ${sec(elapsed)} 秒`);
  out(`  実効の速さ          ${(bytes / 1024 / 1024 / (elapsed / 1000)).toFixed(1)} MB/秒`);
  out(`  申告との一致        ${declared === String(bytes) ? "一致" : `不一致（申告 ${declared ?? "なし"}）`}`);
  out(`  全体                ${sec(Date.now() - t0)} 秒`);
}

function probeResponse(share: string, mode: string): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const out = (line: string) => {
    void writer.write(enc.encode(line + "\n"));
  };

  void (async () => {
    try {
      await runProbe(share, mode, out);
    } catch (e) {
      out("");
      out("=== 途中で止まりました ===");
      out(String(e instanceof Error ? e.message : e));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return text(
          [
            "zoom-to-youtube（第2版）",
            "",
            "  /oauth/start                     … Google の許可を1回通す",
            "  /oauth/status                    … 許可が生きているかを見る",
            "  /probe?share=<共有リンク>        … 録画の情報を取る",
            "  /probe?share=<共有リンク>&mode=drain … 動画の本体も読み切って測る",
            "",
            "まだ動画の運搬はしません。",
          ].join("\n"),
        );

      case "/oauth/start":
        return oauthStart(request, env);

      case "/oauth/callback":
        return oauthCallback(request, env);

      case "/oauth/status":
        return oauthStatus(env);

      case "/probe": {
        const share = url.searchParams.get("share");
        if (!share || !share.startsWith("https://")) {
          return text("share に Zoom の共有リンクを入れてください", 400);
        }
        return probeResponse(share, url.searchParams.get("mode") ?? "meta");
      }

      default:
        return text("見つかりません", 404);
    }
  },
};
