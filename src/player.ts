/**
 * zoom-to-youtube / player.ts（第27版・2026-11-06 開発部・便 1「録画を見る画面」）
 *
 * 共有リンクで開く見る画面。Naoki「YouTube アップに依存せずに、ユーザーに動画を快適かつ管理しやすく提供できると
 * ストレスフリー」（2026-11-06）→ 作る前の 1 枚とデモに OK（12:43）。
 *   ・再生速度（0.75〜2 倍・前回の速度を覚える）・続きから再生・10 秒戻る／進む・全画面
 *   ・文字起こし（今の行が光る・押すとそこへ飛ぶ・中を探せる）・字幕・目次（名前付けの AI が作った目次）
 *   ・今の時間のリンクをコピー（#t秒）
 * 話者の名前は伏せる：シアニン本人は「シアニン」、ほかは出てきた順に「参加者 1」「参加者 2」…。
 * 本文の中で話者の名前が呼ばれているところも（名前）に置き換える。会員の名前を出さない決め（2026-11-02）を画面にも当てる。
 * 本人かどうかは名前の部品のハッシュで見る（公開のリポジトリに本名を書かないため）。
 */

import { parseVtt } from "./archive";

export interface PlayerCue {
  t: number;
  w: string;
  x: string;
}

export interface PlayerChapter {
  t: number;
  name: string;
}

/** シアニン本人の名前の部品（SHA-256 の先頭 16 桁）。竹林・Takebayashi・シアニン・しあにん・Cyan ほか */
const HOST_PIECE_HASHES = new Set([
  "cdc9fdcc767ad06e",
  "77640c95763c25f2",
  "c4bddafc77d898e2",
  "f780cd20c40924a7",
  "f04bf28237f16357",
  "3e3ffdc5ca4187b7",
  "e95bb222e07ff673",
  "3057b5dce3050113",
]);

async function sha16(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function pieces(name: string): string[] {
  const t = name.trim();
  const out = new Set<string>();
  if (t.length >= 2) out.add(t);
  for (const p of t.split(/[\s　・_\-()（）]+/)) if (p.length >= 2) out.add(p);
  return [...out];
}

export async function isHost(name: string): Promise<boolean> {
  for (const p of pieces(name)) if (HOST_PIECE_HASHES.has(await sha16(p))) return true;
  return false;
}

/**
 * Zoom の文字起こし（WebVTT）を、見る画面に出す形にする。話者は伏せ、本文の中の話者の名前も伏せる。
 * 同じ話者が続く短い行は 1 行にまとめる（読みやすさのため・最大 160 字）。
 */
export async function cuesForPlayer(vtt: string): Promise<PlayerCue[]> {
  const cues = parseVtt(vtt);
  const order: string[] = [];
  for (const c of cues) if (c.who && !order.includes(c.who)) order.push(c.who);
  const label = new Map<string, string>();
  const others: string[] = [];
  let n = 0;
  for (const who of order) {
    if (await isHost(who)) label.set(who, "シアニン");
    else {
      label.set(who, `参加者 ${++n}`);
      others.push(who);
    }
  }
  const hide = others.flatMap(pieces).sort((a, b) => b.length - a.length);
  const mask = (s: string) => {
    let out = s;
    for (const p of hide) out = out.split(p).join("（名前）");
    return out;
  };

  const out: PlayerCue[] = [];
  for (const c of cues) {
    const w = c.who ? (label.get(c.who) as string) : "";
    const x = mask(c.text);
    const last = out[out.length - 1];
    if (last && last.w === w && c.sec - last.t < 20 && last.x.length + x.length <= 160) {
      last.x += (/[。！？!?]$/.test(last.x) ? "" : " ") + x;
    } else {
      out.push({ t: c.sec, w, x });
    }
  }
  return out;
}

/** 名前付けの概要欄（要約 3 行＋空行＋「目次」＋「m:ss 題」）から要約と目次を取り出す */
export function parseDescription(desc: string | undefined): { summary: string; chapters: PlayerChapter[] } {
  const lines = (desc ?? "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "目次");
  const head = (at >= 0 ? lines.slice(0, at) : lines).map((l) => l.trim()).filter(Boolean);
  const chapters: PlayerChapter[] = [];
  if (at >= 0) {
    for (const l of lines.slice(at + 1)) {
      const m = l.trim().match(/^(\d{1,2}(?::\d{2}){1,2})\s+(.+)$/);
      if (!m) continue;
      const p = m[1].split(":").map(Number);
      const t = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
      chapters.push({ t, name: m[2].trim() });
    }
  }
  return { summary: head.join(""), chapters };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** script の中に JSON を置く（</script> で切れないように） */
function jsonInScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export interface PlayerPage {
  title: string;
  date?: string;
  videoSrc: string;
  /** この録画のリンク（今の時間のリンクの元） */
  shareUrl: string;
  /** 続きから再生の覚え先（録画ごと） */
  key: string;
  summary: string;
  chapters: PlayerChapter[];
  cues: PlayerCue[];
}

export function playerHtml(p: PlayerPage): string {
  const hasT = p.cues.length > 0;
  const hasC = p.chapters.length >= 2;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(p.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600;800&family=Noto+Sans+JP:wght@400;600;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head>
<body>
<main>
  <div class="head">
    <div class="t">
      <h1>${esc(p.title)}</h1>
      <p class="meta">${p.date ? `収録日 ${esc(p.date)}・` : ""}<span id="dur">--:--</span></p>
    </div>
    <button class="btn" type="button" id="copyAt">今の時間のリンクをコピー</button>
  </div>
  <div class="layout${hasT || hasC ? "" : " solo"}">
    <section class="a-play" aria-label="再生">
      <div class="player">
        <video id="v" playsinline preload="metadata" controlsList="nodownload" src="${esc(p.videoSrc)}"></video>
        <div class="cap" id="cap" hidden aria-hidden="true"></div>
        <button class="bigplay" id="bigplay" type="button" aria-label="再生"><svg width="30" height="30" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></button>
        <div class="resume" id="resume" hidden>
          <span>前回は <b id="resumeAt">0:00</b> まで見ました</span>
          <button class="go" type="button" id="resumeGo">続きから再生</button>
          <button class="no" type="button" id="resumeNo">最初から</button>
        </div>
      </div>
      <div class="ctrl">
        <div class="seek" id="seek" role="slider" tabindex="0" aria-label="再生位置" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0:00">
          <div class="rail"></div><div class="buf" id="buf"></div><div class="fill" id="fill"></div>
          <div id="ticks"></div><div class="knob" id="knob"></div><div class="tip" id="tip" hidden></div>
        </div>
        <div class="row">
          <button class="ib" type="button" id="play" aria-label="再生"><svg viewBox="0 0 24 24" id="playIcon"><path d="M8 5v14l11-7z"/></svg></button>
          <button class="ib" type="button" id="back" aria-label="10 秒戻る"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg></button>
          <button class="ib" type="button" id="fwd" aria-label="10 秒進む"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
          <span class="time"><span id="cur">0:00</span> / <span id="tot">0:00</span></span>
          <span class="chap-now" id="chapNow"></span>
          <div class="speeds" role="group" aria-label="再生速度" id="speeds"></div>
          ${hasT ? `<button class="ib" type="button" id="ccBtn" aria-label="字幕" aria-pressed="false"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/></svg></button>` : ""}
          <button class="ib" type="button" id="fs" aria-label="全画面"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
        </div>
        <div class="kbd">キーボード：Space 再生と一時停止・← → 10 秒・&lt; &gt; 速度${hasT ? "・C 字幕" : ""}</div>
      </div>
    </section>
    ${
      hasT || hasC
        ? `<aside class="side" aria-label="文字起こしと目次">
      <div class="tabs" role="tablist">
        ${hasT ? `<button role="tab" id="tabT" aria-selected="true" aria-controls="panelT">文字起こし<span class="n">${p.cues.length}</span></button>` : ""}
        ${hasC ? `<button role="tab" id="tabC" aria-selected="${hasT ? "false" : "true"}" aria-controls="panelC">目次<span class="n">${p.chapters.length}</span></button>` : ""}
      </div>
      ${
        hasT
          ? `<div id="panelT" role="tabpanel" aria-labelledby="tabT" class="panel">
        <div class="find"><input id="q" type="search" placeholder="文字起こしの中を探す" aria-label="文字起こしの中を探す"><span class="hits" id="hits" aria-live="polite"></span></div>
        <div class="list" id="lines"></div>
        <div class="follow"><span id="followTxt">再生に合わせて送っています</span><button type="button" id="followBtn" hidden>今の位置へ戻る</button></div>
      </div>`
          : ""
      }
      ${hasC ? `<div id="panelC" role="tabpanel" aria-labelledby="tabC" class="panel"${hasT ? " hidden" : ""}><div class="list" id="chaps"></div></div>` : ""}
    </aside>`
        : ""
    }
    ${p.summary ? `<section class="a-below summary" aria-label="この回の要約"><h2>この回の要約</h2><p>${esc(p.summary)}</p></section>` : ""}
  </div>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
const P=${jsonInScript({ chapters: p.chapters, cues: p.cues, share: p.shareUrl, key: p.key })};
${JS}
</script>
</body></html>`;
}

const CSS = `
:root{--bg:#f5f0eb;--panel:#fff;--soft:#f7f3ee;--line:#e6dfd6;--fg:#1a1a1a;--muted:#6b6259;--faint:#736a62;--field:#a39a90;--accent-ink:#b45309;--accent-bg:#fef3c7}
@media (prefers-color-scheme:dark){:root{--bg:#1b1916;--panel:#24211d;--soft:#2b2823;--line:#38332c;--fg:#f1ece6;--muted:#b0a69b;--faint:#a0968b;--field:#6f665c;--accent-ink:#fbbf24;--accent-bg:rgba(251,191,36,.14)}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.7 Geist,"Noto Sans JP",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent-ink);outline-offset:2px;border-radius:6px}
main{max-width:1240px;margin:0 auto;padding:20px 16px 48px}
.head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}.head .t{flex:1;min-width:0}
h1{font-size:22px;font-weight:800;margin:0;line-height:1.4}
.meta{color:var(--muted);font-size:13px;margin:2px 0 0}
.btn{border:1px solid var(--field);background:var(--panel);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px;white-space:nowrap;min-height:32px}
.btn:hover{background:var(--soft)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 380px;grid-template-areas:"play side" "below side";grid-template-rows:auto 1fr;gap:16px;align-items:start}
.layout.solo{grid-template-columns:minmax(0,1fr);grid-template-areas:"play" "below"}
.a-play{grid-area:play;min-width:0}.side{grid-area:side}.a-below{grid-area:below}
@media (max-width:960px){.layout{grid-template-columns:1fr;grid-template-areas:"play" "side" "below"}}
.player{background:#000;border-radius:12px 12px 0 0;overflow:hidden;position:relative;border:1px solid var(--line);border-bottom:0}
.player video{display:block;width:100%;aspect-ratio:16/9;background:#000}
.cap{position:absolute;left:50%;transform:translateX(-50%);bottom:16px;max-width:86%;background:rgba(0,0,0,.72);color:#fff;font-size:16px;line-height:1.5;padding:4px 12px;border-radius:6px;text-align:center;pointer-events:none}
.cap[hidden]{display:none}
.resume[hidden]{display:none}
.resume{position:absolute;left:12px;top:12px;background:rgba(36,33,29,.94);color:#f1ece6;border-radius:10px;padding:8px 10px 8px 14px;display:flex;gap:10px;align-items:center;font-size:13px}
.resume button{border:0;border-radius:8px;padding:4px 10px;cursor:pointer;min-height:30px}
.resume .go{background:#b45309;color:#fff;font-weight:600}.resume .no{background:transparent;color:#d8cfc5}
.bigplay{position:absolute;inset:0;margin:auto;width:72px;height:72px;border-radius:50%;border:0;background:rgba(180,83,9,.92);color:#fff;cursor:pointer;display:grid;place-items:center}
.bigplay[hidden]{display:none}
.ctrl{background:var(--panel);border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;padding:10px 12px}
.seek{position:relative;height:18px;cursor:pointer;touch-action:none}
.seek .rail,.seek .buf,.seek .fill{position:absolute;left:0;top:7px;height:4px;border-radius:2px}
.seek .rail{right:0;background:var(--line)}.seek .buf{background:var(--field);opacity:.5}.seek .fill{background:var(--accent-ink)}
.seek .tick{position:absolute;top:4px;width:2px;height:10px;background:var(--panel)}
.seek .knob{position:absolute;top:2px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--accent-ink);box-shadow:0 0 0 3px var(--panel)}
.seek .tip{position:absolute;bottom:20px;transform:translateX(-50%);background:var(--fg);color:var(--bg);font-size:12px;padding:2px 8px;border-radius:6px;white-space:nowrap;pointer-events:none}
.seek .tip[hidden]{display:none}
.row{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.ib{border:0;background:transparent;border-radius:8px;min-width:36px;height:36px;display:inline-grid;place-items:center;cursor:pointer;padding:0 8px}
.ib:hover{background:var(--soft)}
.ib svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ib[aria-pressed=true]{color:var(--accent-ink)}
.time{font-variant-numeric:tabular-nums;font-size:13px;color:var(--muted);margin:0 6px}
.chap-now{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:80px}
.speeds{display:inline-flex;border:1px solid var(--field);border-radius:8px;overflow:hidden}
.speeds button{border:0;background:transparent;padding:0 8px;height:30px;font-size:12px;cursor:pointer;font-variant-numeric:tabular-nums}
.speeds button+button{border-left:1px solid var(--line)}
.speeds button[aria-pressed=true]{background:#b45309;color:#fff;font-weight:600}
.kbd{font-size:12px;color:var(--faint);margin-top:6px}
.side{background:var(--panel);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;height:calc(100vh - 100px);min-height:420px;position:sticky;top:12px}
@media (max-width:960px){.side{height:auto;position:static}}
.tabs{display:flex;border-bottom:1px solid var(--line);padding:0 8px}
.tabs button{border:0;background:transparent;padding:12px 10px;cursor:pointer;font-size:14px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button[aria-selected=true]{color:var(--fg);font-weight:700;border-bottom-color:var(--accent-ink)}
.tabs .n{font-size:12px;color:var(--faint);margin-left:4px}
.panel{display:flex;flex-direction:column;flex:1;min-height:0}.panel[hidden]{display:none}
.find{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center}
.find input{flex:1;min-width:0;border:1px solid var(--field);background:var(--panel);color:var(--fg);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}
.find .hits{font-size:12px;color:var(--muted);white-space:nowrap}
.list{overflow:auto;flex:1;padding:6px 6px 12px}
@media (max-width:960px){.list{max-height:60vh}}
.line,.chap{display:grid;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;border:0;background:transparent;text-align:left;width:100%}
.line{grid-template-columns:52px 1fr}.chap{grid-template-columns:52px 1fr auto;padding:10px 8px;align-items:center}
.line:hover,.chap:hover{background:var(--soft)}
.ts{font-size:12px;color:var(--accent-ink);font-variant-numeric:tabular-nums;padding-top:2px;font-weight:600}
.who{font-size:12px;color:var(--faint);display:block;line-height:1.4}
.tx{font-size:14px;line-height:1.65}
.line.now,.chap.now{background:var(--accent-bg)}.line.now .tx{font-weight:600}
.chap .nm{font-weight:600}.chap .len{font-size:12px;color:var(--faint)}
.chap.now .nm::after{content:"　再生中";font-size:12px;color:var(--accent-ink)}
mark{background:#fde68a;color:#1a1a1a;border-radius:3px;padding:0 1px}
.empty{padding:12px;color:var(--muted);margin:0}
.follow{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.follow button{border:1px solid var(--field);background:var(--panel);border-radius:8px;padding:2px 10px;cursor:pointer;font-size:12px}
.summary{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.summary h2{font-size:14px;margin:0 0 6px;font-weight:800}.summary p{margin:0}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 16px;border-radius:10px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
@media (max-width:640px){
  h1{font-size:18px}.head{flex-direction:column;gap:8px}
  .ib{min-width:44px;height:44px}.time{flex:1}
  .speeds{order:8;flex-basis:100%;display:flex}.speeds button{flex:1;height:44px}
  .chap-now{flex-basis:100%;order:9}
  .find input{font-size:16px}.tabs button,.line,.chap{min-height:44px}
  .kbd{display:none}.cap{font-size:13px;bottom:8px}
  .resume{font-size:12px;left:8px;right:8px;top:8px}
}`;

const JS = String.raw`
const CH=P.chapters,LINES=P.cues,SPEEDS=[0.75,1,1.25,1.5,1.75,2],KEY="rec:"+P.key+":";
const $=id=>document.getElementById(id),v=$("v");
const fmt=s=>{s=Math.max(0,Math.floor(s||0));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=String(s%60).padStart(2,"0");return h?h+":"+String(m).padStart(2,"0")+":"+x:m+":"+x};
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,x){try{localStorage.setItem(k,x)}catch(e){}}};
const esc=s=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const reEsc=s=>s.replace(/[.*+?^$()|[\]\\{}]/g,"\\$&");
function toast(t){const e=$("toast");e.textContent=t;e.classList.add("show");clearTimeout(toast.h);toast.h=setTimeout(()=>e.classList.remove("show"),1800)}
let speed=parseFloat(store.get("rec:speed"))||1;if(!SPEEDS.includes(speed))speed=1;
function renderSpeeds(){$("speeds").innerHTML=SPEEDS.map(s=>'<button type="button" data-s="'+s+'" aria-pressed="'+(s===speed)+'" aria-label="'+s+' 倍">'+s+'×</button>').join("")}
function setSpeed(s,say){speed=s;v.playbackRate=s;store.set("rec:speed",s);renderSpeeds();if(say)toast("速度を "+s+" 倍にしました")}
$("speeds").addEventListener("click",e=>{const b=e.target.closest("button");if(b)setSpeed(parseFloat(b.dataset.s),true)});renderSpeeds();
function syncPlay(){const p=!v.paused;$("play").setAttribute("aria-label",p?"一時停止":"再生");$("playIcon").innerHTML=p?'<path d="M7 5v14M17 5v14"/>':'<path d="M8 5v14l11-7z"/>';$("bigplay").hidden=p||v.currentTime>0.2}
const toggle=()=>v.paused?v.play().catch(()=>{}):v.pause();
$("play").onclick=toggle;$("bigplay").onclick=()=>{$("resume").hidden=true;v.play().catch(()=>{})};v.onclick=toggle;
v.addEventListener("play",syncPlay);v.addEventListener("pause",syncPlay);
$("back").onclick=()=>v.currentTime=Math.max(0,v.currentTime-10);
$("fwd").onclick=()=>v.currentTime=Math.min(v.duration||0,v.currentTime+10);
$("fs").onclick=()=>{const p=document.querySelector(".player");try{document.fullscreenElement?document.exitFullscreen():(p.requestFullscreen?p.requestFullscreen():v.webkitEnterFullscreen&&v.webkitEnterFullscreen())}catch(e){}};
let cc=store.get("rec:cc")==="1";
function setCC(x){cc=x;store.set("rec:cc",x?"1":"0");if($("ccBtn"))$("ccBtn").setAttribute("aria-pressed",x);updateCap()}
if($("ccBtn"))$("ccBtn").onclick=()=>{setCC(!cc);toast(cc?"字幕を出しました":"字幕を消しました")};
const linesEl=$("lines");let lastLine=-1,lastChap=-1,follow=true,autoScrolling=false;
function renderLines(q){if(!linesEl)return;let hits=0;const html=LINES.map((l,i)=>{let tx=esc(l.x);if(q){if(!l.x.toLowerCase().includes(q.toLowerCase()))return"";tx=tx.replace(new RegExp(reEsc(esc(q)),"gi"),m=>{hits++;return"<mark>"+m+"</mark>"})}
return '<button type="button" class="line" data-i="'+i+'" data-t="'+l.t+'"><span class="ts">'+fmt(l.t)+'</span><span>'+(l.w?'<span class="who">'+esc(l.w)+'</span>':'')+'<span class="tx">'+tx+'</span></span></button>'}).join("");
linesEl.innerHTML=html||'<p class="empty">「'+esc(q)+'」は見つかりません</p>';$("hits").textContent=q?hits+" 件":"";lastLine=-1;tick()}
if(linesEl){linesEl.addEventListener("click",e=>{const b=e.target.closest(".line");if(!b)return;v.currentTime=+b.dataset.t;follow=true;showFollow();if(v.paused)v.play().catch(()=>{})});
$("q").addEventListener("input",e=>renderLines(e.target.value.trim()));
linesEl.addEventListener("scroll",()=>{if(!autoScrolling&&follow){follow=false;showFollow()}});
$("followBtn").onclick=()=>{follow=true;showFollow();lastLine=-1;tick()}}
function showFollow(){$("followBtn").hidden=follow;$("followTxt").textContent=follow?"再生に合わせて送っています":"送りを止めています"}
function chapLen(i){const end=i+1<CH.length?CH[i+1].t:(v.duration||CH[i].t);return fmt(end-CH[i].t)}
function renderChaps(){if($("chaps"))$("chaps").innerHTML=CH.map((c,i)=>'<button type="button" class="chap" data-t="'+c.t+'" data-i="'+i+'"><span class="ts">'+fmt(c.t)+'</span><span class="nm">'+esc(c.name)+'</span><span class="len">'+chapLen(i)+'</span></button>').join("")}
if($("chaps"))$("chaps").addEventListener("click",e=>{const b=e.target.closest(".chap");if(b){v.currentTime=+b.dataset.t;if(v.paused)v.play().catch(()=>{})}});
function tab(w){const tT=$("tabT"),tC=$("tabC");if(!tT||!tC)return;const t=w==="T";tT.setAttribute("aria-selected",t);tC.setAttribute("aria-selected",!t);$("panelT").hidden=!t;$("panelC").hidden=t;store.set("rec:tab",w)}
if($("tabT"))$("tabT").onclick=()=>tab("T");if($("tabC"))$("tabC").onclick=()=>tab("C");
const tabs=document.querySelector(".tabs");if(tabs)tabs.addEventListener("keydown",e=>{if((e.key==="ArrowRight"||e.key==="ArrowLeft")&&$("tabT")&&$("tabC")){const n=$("tabT").getAttribute("aria-selected")==="true"?"C":"T";tab(n);$(n==="T"?"tabT":"tabC").focus()}});
const seek=$("seek");
function drawTicks(){if(!v.duration)return;$("ticks").innerHTML=CH.slice(1).map(c=>'<div class="tick" style="left:'+(c.t/v.duration*100)+'%"></div>').join("")}
function posToTime(x){const r=seek.getBoundingClientRect();return Math.min(1,Math.max(0,(x-r.left)/r.width))*(v.duration||0)}
function idxAt(arr,t,get){let i=0;for(let k=0;k<arr.length;k++){if(t>=get(arr[k]))i=k;else break}return i}
let drag=false;
seek.addEventListener("pointerdown",e=>{drag=true;seek.setPointerCapture(e.pointerId);v.currentTime=posToTime(e.clientX)});
seek.addEventListener("pointermove",e=>{const t=posToTime(e.clientX),r=seek.getBoundingClientRect(),tip=$("tip");tip.hidden=false;tip.style.left=(e.clientX-r.left)+"px";tip.textContent=fmt(t)+(CH.length?"　"+CH[idxAt(CH,t,c=>c.t)].name:"");if(drag)v.currentTime=t});
seek.addEventListener("pointerup",()=>drag=false);seek.addEventListener("pointerleave",()=>{if(!drag)$("tip").hidden=true});
seek.addEventListener("keydown",e=>{if(e.key==="ArrowRight"){v.currentTime+=5;e.preventDefault()}if(e.key==="ArrowLeft"){v.currentTime-=5;e.preventDefault()}});
function updateCap(){const c=$("cap");if(!cc||!LINES.length){c.hidden=true;return}c.hidden=false;c.textContent=LINES[idxAt(LINES,v.currentTime,l=>l.t)].x}
function tick(){const p=v.duration?v.currentTime/v.duration*100:0;$("fill").style.width=p+"%";$("knob").style.left=p+"%";$("cur").textContent=fmt(v.currentTime);
seek.setAttribute("aria-valuenow",Math.round(p));seek.setAttribute("aria-valuetext",fmt(v.currentTime));
if(!v.paused||v.currentTime>0.2)$("bigplay").hidden=true;
try{if(v.buffered.length&&v.duration)$("buf").style.width=(v.buffered.end(v.buffered.length-1)/v.duration*100)+"%"}catch(e){}
if(linesEl&&LINES.length){const li=idxAt(LINES,v.currentTime,l=>l.t);if(li!==lastLine){lastLine=li;linesEl.querySelectorAll(".line.now").forEach(x=>x.classList.remove("now"));const el=linesEl.querySelector('.line[data-i="'+li+'"]');if(el){el.classList.add("now");if(follow){autoScrolling=true;el.scrollIntoView({block:"center",behavior:"smooth"});setTimeout(()=>autoScrolling=false,600)}}}}
if(CH.length){const ci=idxAt(CH,v.currentTime,c=>c.t);if(ci!==lastChap){lastChap=ci;$("chapNow").textContent=CH[ci].name;document.querySelectorAll(".chap").forEach(x=>x.classList.toggle("now",+x.dataset.i===ci))}}
updateCap()}
let lastSave=0;
v.addEventListener("timeupdate",()=>{tick();const now=Date.now();if(v.currentTime>5&&now-lastSave>3000){lastSave=now;store.set(KEY+"pos",v.currentTime)}});
v.addEventListener("seeked",tick);v.addEventListener("ended",()=>store.set(KEY+"pos","0"));
function onMeta(){if(onMeta.done)return;onMeta.done=true;$("tot").textContent=fmt(v.duration);$("dur").textContent=fmt(v.duration);v.playbackRate=speed;drawTicks();renderChaps();tick();
const h=location.hash.match(/^#t(\d+)$/),saved=parseFloat(store.get(KEY+"pos"));
if(h)v.currentTime=Math.min(+h[1],v.duration||0);else if(saved>5&&saved<v.duration-5){$("resumeAt").textContent=fmt(saved);$("resume").hidden=false}}
v.addEventListener("loadedmetadata",onMeta);if(v.readyState>=1)onMeta();
$("resumeGo").onclick=()=>{v.currentTime=parseFloat(store.get(KEY+"pos"))||0;$("resume").hidden=true;v.play().catch(()=>{})};
$("resumeNo").onclick=()=>{store.set(KEY+"pos","0");v.currentTime=0;$("resume").hidden=true;$("bigplay").focus()};
v.addEventListener("ratechange",()=>{if(v.playbackRate!==speed){speed=v.playbackRate;renderSpeeds()}});
document.addEventListener("keydown",e=>{if(e.target.matches("input,textarea")||e.metaKey||e.ctrlKey||e.altKey)return;
if(e.key===" "&&!e.target.matches("button")){e.preventDefault();toggle()}
else if(e.key==="ArrowRight"&&e.target===document.body)v.currentTime+=10;
else if(e.key==="ArrowLeft"&&e.target===document.body)v.currentTime-=10;
else if(e.key===">"||e.key==="."){const i=SPEEDS.indexOf(speed);if(i<SPEEDS.length-1)setSpeed(SPEEDS[i+1],true)}
else if(e.key==="<"||e.key===","){const i=SPEEDS.indexOf(speed);if(i>0)setSpeed(SPEEDS[i-1],true)}
else if((e.key==="c"||e.key==="C")&&$("ccBtn")){setCC(!cc);toast(cc?"字幕を出しました":"字幕を消しました")}});
$("copyAt").onclick=async()=>{const link=P.share+"#t"+Math.floor(v.currentTime);try{await navigator.clipboard.writeText(link);toast(fmt(v.currentTime)+" から始まるリンクをコピーしました")}catch(e){toast(link)}};
renderLines("");setCC(cc);tab(store.get("rec:tab")==="C"?"C":"T");syncPlay();
`;
