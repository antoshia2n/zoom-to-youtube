/**
 * zoom-to-youtube / 探査の口（第1版・2026-08-20 開発部）
 *
 * この版は「測るだけ」。まだ Google ドライブにも YouTube にも何も書きません。
 * 目的は次の4つを Cloudflare の上で実測すること。
 *   1. Zoom の共有リンク1本から、動画の直リンクと文字起こしが取れるか
 *   2. 159MB の動画を Cloudflare が何秒で読み切れるか
 *   3. 途中から再開できるか（Range に対応しているか）
 *   4. 動画を溜め込まずに素通しできるか（メモリ128MBを超えないか）
 *
 * 測り終わったら、この /probe の口は消します（段階Bの実装を入れる回）。
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BASE = "https://us02web.zoom.us";

/** Zoom は途中の応答で cookie を配るので、自分で持ち回す */
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

function headers(jar: Jar, referer?: string, accept?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA };
  if (referer) h["Referer"] = referer;
  if (accept) h["Accept"] = accept;
  const ck = jar.header();
  if (ck) h["Cookie"] = ck;
  return h;
}

/** リダイレクトを自分で追う（途中の cookie を落とさないため） */
async function go(
  jar: Jar,
  url: string,
  referer?: string,
  accept?: string,
): Promise<{ res: Response; url: string }> {
  let cur = url;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(cur, {
      headers: headers(jar, referer, accept),
      redirect: "manual",
    });
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

function sec(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function run(share: string, mode: string, out: (line: string) => void): Promise<void> {
  const jar = new Jar();
  const t0 = Date.now();

  out("【1】共有ページを開く");
  const a = await go(jar, share);
  if (a.res.status !== 200) throw new Error(`共有ページが ${a.res.status} を返しました`);
  const html = await a.res.text();
  const m = html.match(/meetingId:\s*'([^']+)'/);
  if (!m) {
    throw new Error(
      "共有ページに meetingId がありません。共有リンクが切れているか、パスワードが要る設定です。",
    );
  }
  const meetingId = m[1];
  out(`      取れた（${sec(Date.now() - t0)} 秒）`);

  out("【2】再生ページの場所を聞く");
  const s = await go(jar, `${BASE}/nws/recording/1.0/play/share-info/${meetingId}`, share, "application/json");
  const sj = (await s.res.json()) as { status?: boolean; errorMessage?: string; result?: { redirectUrl?: string } };
  if (!sj.status || !sj.result?.redirectUrl) {
    throw new Error(`share-info が失敗しました: ${sj.errorMessage ?? "理由なし"}`);
  }
  const playPath = sj.result.redirectUrl;
  const pid = playPath.split("/").filter(Boolean).pop() as string;
  const playUrl = BASE + playPath;
  out("      取れた");

  out("【3】再生ページを1回踏む");
  const p = await go(jar, playUrl, share);
  await p.res.body?.cancel();
  out(`      ${p.res.status}`);

  out("【4】録画の情報を取る");
  const i = await go(jar, `${BASE}/nws/recording/1.0/play/info/${pid}`, playUrl, "application/json");
  const ij = (await i.res.json()) as {
    status?: boolean;
    errorMessage?: string;
    result?: Record<string, unknown>;
  };
  if (!ij.status || !ij.result) {
    throw new Error(`info が失敗しました: ${ij.errorMessage ?? "理由なし"}`);
  }
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
  out(`  申告サイズ    ${r.recording?.fileSizeInMB ?? "（なし）"} MB`);
  out(`  文字起こし    ${r.hasTranscript ? "あり" : "なし"}`);
  out(`  取得の禁止    ${r.disableDownload ? "オン（取れない）" : "オフ"}`);
  out(`  チャット      ${(r.xmppList ?? []).length} 件`);
  out(`  直リンクの元  ${new URL(mp4Url).hostname}`);
  out("");

  if (r.transcriptUrl) {
    out("【5】文字起こしを取る");
    const v = await go(jar, BASE + r.transcriptUrl, playUrl);
    const vtt = await v.res.text();
    out(`      ${vtt.length} 文字 / 区切り ${vtt.split("-->").length - 1} 個`);
    out("");
  }

  out("【6】途中から再開できるかを見る");
  const rng = await fetch(mp4Url, {
    headers: { ...headers(jar, playUrl), Range: "bytes=0-99" },
  });
  await rng.body?.cancel();
  out(
    rng.status === 206
      ? "      できる（206 が返った）。失敗しても続きから再開できる"
      : `      できない（${rng.status} が返った）。失敗したら最初からやり直しになる`,
  );
  out("");

  if (mode !== "drain") {
    out(`ここまで ${sec(Date.now() - t0)} 秒。本体の転送は測っていません。`);
    out("本体まで測るには、URL の末尾に &mode=drain を足してもう一度開いてください。");
    return;
  }

  out("【7】動画の本体を読み切る（溜め込まずに捨てながら読む）");
  const tDl = Date.now();
  const dl = await fetch(mp4Url, { headers: headers(jar, playUrl) });
  const ttfb = Date.now() - tDl;
  if (!dl.ok || !dl.body) throw new Error(`本体が ${dl.status} を返しました`);
  const declared = dl.headers.get("content-length");
  out(`      最初の1バイトまで ${sec(ttfb)} 秒 / 申告 ${declared ?? "なし"} バイト`);

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
  out("");
  out("  メモリを超えていればこの応答は途中で切れます。ここまで出ていれば素通しは通っています。");
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        [
          "zoom-to-youtube 探査の口（測るだけ・書き込みはしません）",
          "",
          "使い方：",
          "  /probe?share=<Zoom の共有リンク>            … 情報だけ取る（数秒）",
          "  /probe?share=<Zoom の共有リンク>&mode=drain … 動画の本体も読み切って時間を測る",
          "",
          "共有リンクはそのまま貼って構いません（記号は自動で処理されます）。",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname !== "/probe") {
      return new Response("見つかりません", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const share = url.searchParams.get("share");
    if (!share || !share.startsWith("https://")) {
      return new Response("share に Zoom の共有リンクを入れてください", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const mode = url.searchParams.get("mode") ?? "meta";

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const out = (line: string) => {
      void writer.write(enc.encode(line + "\n"));
    };

    void (async () => {
      try {
        await run(share, mode, out);
      } catch (e) {
        out("");
        out("=== 途中で止まりました ===");
        out(String(e instanceof Error ? e.message : e));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
