"""
zoom-to-youtube / scripts/edit.py（第53・54版・2026-11-19 開発部・動画の自動編集 便 1・テロップの作り直し）

GitHub Actions の中で動く。録画 1 本を zoom-to-youtube から受け取り、ffmpeg で
  ・ジェットカット（無音を詰める。間は 0.4 秒だけ残す）
  ・音質の改善（低い雑音を切る・雑音を減らす・音量を YouTube の目安 -16LUFS にそろえる）
  ・テロップ（第54版：文字起こしの全文ではなく、AI が要約した短い言葉を 3 種の型で焼き込む
      A 通常＝白い字に二重のふち・下／B 強調＝黄色の大きな字でポンと出す・下／C キーワード＝中央にオレンジの板で 3.5 秒）
  ・上の帯（目次の見出しを、話題が変わるたびに左上へ出す。左にオレンジの帯・サムネの型 A と同じ色）
をかけて、編集版を棚へ「【編集版】…」として返す。

実行の記録は公開なので、題名・目次・文字起こしの中身は出さない（分・本数・数だけ）。
手元で試すとき：python3 scripts/edit.py --local 動画.mp4 文字起こし.vtt 出力.mp4
"""
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time

BASE = "https://zoom-to-youtube.gameister1.workers.dev"
AUDIENCE = "zoom-to-youtube-edit"

# ジェットカットの決め
SILENCE_DB = -35      # これより静かな音は「無音」
SILENCE_MIN = 0.8     # この長さ以上の無音だけ詰める
PAD = 0.2             # 話の前後に残す（詰めたあとの間は 0.4 秒）
FPS = 30

# 見た目の決め（サムネの型 A：明るい地・大きな字・左にオレンジの帯）
FONT = "Noto Sans CJK JP"
ORANGE = "&H0045A0FF"  # ASS は &HAABBGGRR。#FFA045
NAVY = "&H00402818"    # #182840
WHITE_BOX = "&H18FFFFFF"
YELLOW = "&H0000E6FF"   # #FFE600
BLACK = "&H00000000"
WHITE = "&H00FFFFFF"
LINE_CHARS = 16        # テロップ 1 行の字数
PLAN_CHUNK = 40        # AI に 1 回で渡す文字起こしの行数
VER = "v2"             # 編集版の題名に付ける版（同じ録画を作り直したとき見分けるため）
FILLERS = re.compile(r"(えー+と?|ええと|えっと|あのー+|うーん|んー+|まあまあ)[、。,\s]*")


# ------------------------------------------------------------------
# 受け渡し
# ------------------------------------------------------------------

def gh_token() -> str:
    import requests
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=" + AUDIENCE
    r = requests.get(url, headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]}, timeout=30)
    r.raise_for_status()
    return r.json()["value"]


def call(method: str, path: str, **kw):
    import requests
    h = kw.pop("headers", {})
    h["Authorization"] = "Bearer " + gh_token()
    return requests.request(method, BASE + path, headers=h, timeout=kw.pop("timeout", 120), **kw)


def wait_source(rid: str) -> dict:
    """反映（Workers Builds）が終わるまで待つ。口が無いうちは 404 のテキストが返る"""
    import requests
    q = requests.utils.quote(rid, safe="")
    for _ in range(40):
        r = call("GET", "/edit/source?id=" + q)
        if r.ok and r.headers.get("content-type", "").startswith("application/json"):
            return r.json()
        if r.status_code == 404 and "録画が無い" in r.text:
            raise RuntimeError("録画が無い（id を確かめる）")
        if r.status_code == 401:
            raise RuntimeError("本人確認で断られた：" + r.json().get("error", ""))
        time.sleep(15)
    raise RuntimeError("編集の口が開かない（反映が終わっていない）")


def download(path: str, dest: str) -> None:
    with call("GET", path, stream=True, timeout=900) as r:
        if not r.ok:
            raise RuntimeError(f"受け取れない（{r.status_code}）")
        with open(dest, "wb") as f:
            for chunk in r.iter_content(8 * 1024 * 1024):
                f.write(chunk)


def upload(rid: str, path: str) -> str:
    import requests
    size = os.path.getsize(path)
    r = call("POST", "/edit/up-start?id=" + requests.utils.quote(rid, safe=""), json={"size": size, "ver": VER})
    j = r.json()
    if not j.get("ok"):
        raise RuntimeError("入れ始められない：" + str(j.get("error")))
    uid, part, total = j["id"], int(j["part_size"]), int(j["parts_total"])
    done = set(j.get("parts_done") or [])
    with open(path, "rb") as f:
        for n in range(1, total + 1):
            buf = f.read(part)
            if n in done:
                continue
            for attempt in range(4):
                rr = call("PUT", f"/edit/up-part?u={uid}&n={n}", data=buf, timeout=600)
                if rr.ok and rr.json().get("ok"):
                    break
                time.sleep(10 * (attempt + 1))
            else:
                raise RuntimeError(f"片 {n} を入れられない")
    r = call("POST", f"/edit/up-done?u={uid}&id=" + requests.utils.quote(rid, safe=""), timeout=300)
    if not r.json().get("ok"):
        raise RuntimeError("まとめられない：" + str(r.json().get("error")))
    return uid


def plan_telops(cues: list) -> tuple:
    """文字起こしを PLAN_CHUNK 行ずつ AI に渡し、要約テロップ（元の秒・型・言葉）を受け取る"""
    out, failed = [], 0
    for k in range(0, len(cues), PLAN_CHUNK):
        part = cues[k:k + PLAN_CHUNK]
        lines = [[k + j, round(a, 1), t] for j, (a, b, t) in enumerate(part)]
        try:
            r = call("POST", "/edit/plan", json={"lines": lines}, timeout=300)
            j = r.json()
        except Exception:
            j = {"ok": False}
        if not j.get("ok"):
            failed += 1
            continue
        for t in j.get("telops") or []:
            f, to = int(t["from"]), int(t["to"])
            if 0 <= f <= to < len(cues):
                out.append({"a": cues[f][0], "b": cues[to][1], "type": t.get("type", "A"), "text": str(t.get("text", ""))})
    return out, failed


# ------------------------------------------------------------------
# 編集
# ------------------------------------------------------------------

def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    j = json.loads(out)
    st = (j.get("streams") or [{}])[0]
    return {"w": int(st.get("width") or 1280), "h": int(st.get("height") or 720), "dur": float(j["format"]["duration"])}


def speech_segments(path: str, dur: float) -> list:
    """無音を探し、話している区間（前後に PAD）を返す"""
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", f"silencedetect=noise={SILENCE_DB}dB:d={SILENCE_MIN}", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    sil, start = [], None
    for line in err.splitlines():
        m = re.search(r"silence_start: (-?[\d.]+)", line)
        if m:
            start = max(0.0, float(m.group(1)))
        m = re.search(r"silence_end: ([\d.]+)", line)
        if m and start is not None:
            sil.append((start, float(m.group(1))))
            start = None
    if start is not None:
        sil.append((start, dur))
    keep, t = [], 0.0
    for a, b in sil:
        if a > t:
            keep.append((t, a))
        t = b
    if t < dur:
        keep.append((t, dur))
    out = []
    for a, b in keep:
        a, b = max(0.0, a - PAD), min(dur, b + PAD)
        if out and a <= out[-1][1] + 0.05:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return [(a, b) for a, b in out if b - a >= 0.3] or [(0.0, dur)]


class Timeline:
    """元の秒 → 詰めたあとの秒"""

    def __init__(self, segs: list):
        self.segs = segs
        self.offs, o = [], 0.0
        for a, b in segs:
            self.offs.append(o)
            o += b - a
        self.total = o

    def map(self, t: float) -> float:
        for (a, b), o in zip(self.segs, self.offs):
            if t < a:
                return o
            if t <= b:
                return o + (t - a)
        return self.total


def parse_vtt(text: str) -> list:
    def sec(s: str) -> float:
        p = s.strip().replace(",", ".").split(":")
        p = [float(x) for x in p]
        return p[0] * 3600 + p[1] * 60 + p[2] if len(p) == 3 else p[0] * 60 + p[1]

    cues, lines = [], text.replace("\r", "").split("\n")
    i = 0
    while i < len(lines):
        m = re.match(r"\s*([\d:.,]+)\s*-->\s*([\d:.,]+)", lines[i])
        if m:
            a, b = sec(m.group(1)), sec(m.group(2))
            body = []
            i += 1
            while i < len(lines) and lines[i].strip():
                body.append(lines[i].strip())
                i += 1
            t = " ".join(body)
            t = re.sub(r"^[^:：]{1,30}[:：]\s*", "", t)  # 話者の名前を外す（テロップに名前を出さない）
            t = FILLERS.sub("", t).strip(" 、")
            if t:
                cues.append((a, b, t))
        i += 1
    return cues


def split_text(t: str) -> list:
    """長い文を、句読点を優先して 2 行ぶん（LINE_CHARS×2）ずつに分ける"""
    limit = LINE_CHARS * 2
    pieces, cur = [], ""
    for ch in re.split(r"(?<=[。！？!?、])", t):
        if not ch:
            continue
        while len(ch) > limit:
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(ch[:limit])
            ch = ch[limit:]
        if len(cur) + len(ch) > limit:
            pieces.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        pieces.append(cur)
    return [p.strip(" 、") for p in pieces if p.strip(" 、")]


def wrap(t: str) -> str:
    if len(t) <= LINE_CHARS:
        return t
    cut = LINE_CHARS
    for k in range(min(len(t) - 1, LINE_CHARS + 2), 5, -1):
        if t[k - 1] in "、。！？":
            cut = k
            break
    return t[:cut] + r"\N" + t[cut:]


def ass_time(s: float) -> str:
    s = max(0.0, s)
    cs = int(round(s * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    sec, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{sec:02d}.{cs:02d}"


def esc(t: str) -> str:
    return t.replace("\\", "＼").replace("{", "｛").replace("}", "｝").replace("\n", " ")


def build_ass(w: int, h: int, cues: list, chapters: list, tl: Timeline) -> tuple:
    fa, fb, fc = round(h * 0.068), round(h * 0.09), round(h * 0.083)
    mx, mv = round(w * 0.05), round(h * 0.06)
    bfs = round(h * 0.042)
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: AOut,{FONT} Black,{fa},{WHITE},{WHITE},{NAVY},{BLACK},-1,0,0,0,100,100,1,0,1,{round(fa * 0.21)},0,2,{mx},{mx},{mv},1
Style: A,{FONT} Black,{fa},{WHITE},{WHITE},{BLACK},{BLACK},-1,0,0,0,100,100,1,0,1,{round(fa * 0.08)},0,2,{mx},{mx},{mv},1
Style: BOut,{FONT} Black,{fb},{YELLOW},{YELLOW},{WHITE},{BLACK},-1,0,0,0,100,100,2,0,1,{round(fb * 0.18)},0,2,{mx},{mx},{mv},1
Style: B,{FONT} Black,{fb},{YELLOW},{YELLOW},{NAVY},{BLACK},-1,0,0,0,100,100,2,0,1,{round(fb * 0.09)},0,2,{mx},{mx},{mv},1
Style: C,{FONT} Black,{fc},{NAVY},{NAVY},{ORANGE},{BLACK},-1,0,0,0,100,100,2,0,3,{round(fc * 0.37)},0,5,{mx},{mx},0,1
Style: Band,{FONT},{bfs},{NAVY},{NAVY},&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: Box,{FONT},10,{WHITE_BOX},{WHITE_BOX},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev, n_telop = [], 0
    pop = r"{\fscx70\fscy70\t(0,120,\fscx112\fscy112)\t(120,220,\fscx100\fscy100)}"
    tels = sorted(cues, key=lambda x: x["a"])
    for i, t in enumerate(tels):
        a, b = t["a"], min(t["b"], t["a"] + 8.0)
        nxt = tels[i + 1]["a"] if i + 1 < len(tels) else b + 2
        if b - a < 1.4:
            b = min(a + 1.4, nxt)
        s_, e_ = tl.map(a), tl.map(b)
        if e_ - s_ < 0.6:
            continue
        ts, te = ass_time(s_), ass_time(e_)
        if t["type"] == "C":
            te = ass_time(min(e_, s_ + 3.5))
            ev.append(f"Dialogue: 6,{ts},{te},C,,0,0,0,,{{\\fad(150,200)}}{pop}{esc(t['text'])[:16]}")
        elif t["type"] == "B":
            txt = esc(t["text"].replace("／", ""))[:16]
            ev.append(f"Dialogue: 5,{ts},{te},BOut,,0,0,0,,{pop}{txt}")
            ev.append(f"Dialogue: 6,{ts},{te},B,,0,0,0,,{pop}{txt}")
        else:
            txt = r"\N".join(wrap(esc(x.strip())) for x in t["text"].split("／") if x.strip())
            fade = r"{\fad(80,80)}"
            ev.append(f"Dialogue: 5,{ts},{te},AOut,,0,0,0,,{fade}{txt}")
            ev.append(f"Dialogue: 6,{ts},{te},A,,0,0,0,,{fade}{txt}")
        n_telop += 1

    # 上の帯：目次の見出しを、次の見出しまで
    chs = sorted([c for c in chapters if c.get("name")], key=lambda c: c["t"])
    pad, bar = round(h * 0.022), round(h * 0.012)
    x0, y0 = round(w * 0.025), round(h * 0.03)
    n_band = 0
    for i, c in enumerate(chs):
        s = tl.map(float(c["t"]))
        e = tl.map(float(chs[i + 1]["t"])) if i + 1 < len(chs) else tl.total
        if e - s < 2:
            continue
        name = esc(str(c["name"]))[:22]
        bw = len(name) * bfs + pad * 2 + bar
        bh = bfs + pad * 2
        ts, te = ass_time(s), ass_time(e)
        fade = r"\fad(250,250)"
        ev.append(f"Dialogue: 2,{ts},{te},Box,,0,0,0,,{{{fade}\\pos({x0},{y0})\\p1}}m 0 0 l {bw} 0 {bw} {bh} 0 {bh}{{\\p0}}")
        ev.append(f"Dialogue: 3,{ts},{te},Box,,0,0,0,,{{{fade}\\pos({x0},{y0})\\1c{ORANGE}\\p1}}m 0 0 l {bar} 0 {bar} {bh} 0 {bh}{{\\p0}}")
        ev.append(f"Dialogue: 4,{ts},{te},Band,,0,0,0,,{{{fade}\\pos({x0 + bar + pad},{y0 + pad})}}{name}")
        n_band += 1
    return head + "\n".join(ev) + "\n", n_telop, n_band


def render(src: str, ass: str, segs: list, out: str, work: str) -> None:
    expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in segs)
    graph = (
        f"[0:v]fps={FPS},select='{expr}',setpts=N/{FPS}/TB,subtitles='{ass}'[v];"
        f"[0:a]aselect='{expr}',asetpts=N/SR/TB,highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]"
    )
    script = os.path.join(work, "graph.txt")
    with open(script, "w", encoding="utf-8") as f:
        f.write(graph)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-stats_period", "60", "-y", "-i", src, "-filter_complex_script", script,
         "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out],
        check=True,
    )


def edit(src: str, vtt: str, chapters: list, out: str, work: str, telops: list = None) -> dict:
    info = probe(src)
    segs = speech_segments(src, info["dur"])
    tl = Timeline(segs)
    cues = parse_vtt(vtt) if vtt else []
    failed = 0
    if telops is None:
        telops, failed = plan_telops(cues) if cues else ([], 0)
    ass_text, n_telop, n_band = build_ass(info["w"], info["h"], telops, chapters, tl)
    ass = os.path.join(work, "edit.ass")
    with open(ass, "w", encoding="utf-8") as f:
        f.write(ass_text)
    render(src, ass, segs, out, work)
    return {
        "before_min": round(info["dur"] / 60, 1),
        "after_min": round(tl.total / 60, 1),
        "cuts": max(0, len(segs) - 1),
        "lines": len(cues),
        "telops": n_telop,
        "types": {k: sum(1 for t in telops if t["type"] == k) for k in "ABC"},
        "plan_failed": failed,
        "bands": n_band,
        "mb": round(os.path.getsize(out) / 1048576),
    }


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "--local":
        src, vtt_path, out = sys.argv[2], sys.argv[3], sys.argv[4]
        chapters = json.loads(sys.argv[5]) if len(sys.argv) > 5 else []
        telops = json.load(open(sys.argv[6], encoding="utf-8")) if len(sys.argv) > 6 else None
        with tempfile.TemporaryDirectory() as work:
            vtt = open(vtt_path, encoding="utf-8").read() if vtt_path != "-" else ""
            print(json.dumps(edit(src, vtt, chapters, out, work, telops), ensure_ascii=False))
        return

    rid = (os.environ.get("REC_ID_INPUT") or "").strip()
    if not rid:
        with open(".github/edit-request.json", encoding="utf-8") as f:
            rid = str(json.load(f).get("id", "")).strip()
    if not rid:
        raise SystemExit("id が無い")
    import requests
    q = requests.utils.quote(rid, safe="")
    src_info = wait_source(rid)
    with tempfile.TemporaryDirectory() as work:
        src = os.path.join(work, "src.mp4")
        download("/edit/file?id=" + q, src)
        vtt = ""
        if src_info.get("has_vtt"):
            r = call("GET", "/edit/vtt?id=" + q, timeout=300)
            vtt = r.text if r.ok else ""
        out = os.path.join(work, "out.mp4")
        t0 = time.time()
        res = edit(src, vtt, src_info.get("chapters") or [], out, work)
        os.remove(src)
        res["encode_min"] = round((time.time() - t0) / 60, 1)
        uid = upload(rid, out)
        res["upload"] = "ok" if uid else "ng"
    # 記録には数だけを出す（題名・中身は出さない）
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
