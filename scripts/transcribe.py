"""
zoom-to-youtube / scripts/transcribe.py（第47版・2026-11-17 開発部）

GitHub Actions の中で動く。文字起こしが無い録画を zoom-to-youtube から 1 本ずつ受け取り、
ffmpeg で 10 分ごとの mp3 に切って OpenAI whisper-1（時刻付き）へ送り、時刻をつないで VTT にして返す。

実行の記録は公開なので、題名・文字起こしの中身・住所は出さない（日付・分・本数だけ）。
"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import time

import requests

BASE = "https://zoom-to-youtube.gameister1.workers.dev"
AUDIENCE = "zoom-to-youtube-transcribe"
SEG = 600  # 10 分
OPENAI = "https://api.openai.com/v1/audio/transcriptions"


def gh_token() -> str:
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=" + AUDIENCE
    r = requests.get(url, headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]}, timeout=30)
    r.raise_for_status()
    return r.json()["value"]


def call(method: str, path: str, **kw) -> requests.Response:
    # 本人確認は短い時間で切れるので、毎回取り直す
    h = kw.pop("headers", {})
    h["Authorization"] = "Bearer " + gh_token()
    return requests.request(method, BASE + path, headers=h, timeout=kw.pop("timeout", 120), **kw)


def limit() -> int:
    v = (os.environ.get("LIMIT_INPUT") or "").strip()
    if not v:
        with open(".github/transcribe-request.json", encoding="utf-8") as f:
            v = str(json.load(f).get("limit", 5))
    return max(1, min(300, int(v)))


def stamp(sec: float) -> str:
    sec = max(0.0, sec)
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def whisper(path: str) -> list:
    last = ""
    for attempt in range(4):
        with open(path, "rb") as f:
            r = requests.post(
                OPENAI,
                headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]},
                files={"file": (os.path.basename(path), f, "audio/mpeg")},
                data={"model": "whisper-1", "language": "ja", "response_format": "verbose_json", "timestamp_granularities[]": "segment"},
                timeout=600,
            )
        if r.ok:
            return r.json().get("segments") or []
        last = f"OpenAI {r.status_code}"
        if r.status_code in (401, 403):
            raise RuntimeError(last + "（鍵が使えない）")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(last)


def one(row: dict, work: str) -> dict:
    src = os.path.join(work, "src." + (row.get("ext") or "bin"))
    with call("GET", "/transcribe/file?id=" + requests.utils.quote(row["id"], safe=""), stream=True, timeout=600) as r:
        if not r.ok:
            raise RuntimeError(f"録画を受け取れない（{r.status_code}）")
        with open(src, "wb") as f:
            for chunk in r.iter_content(8 * 1024 * 1024):
                f.write(chunk)
    total = duration(src)
    if total <= 0:
        raise RuntimeError("長さが読めない")
    listing = os.path.join(work, "list.csv")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
         "-f", "segment", "-segment_time", str(SEG), "-reset_timestamps", "1",
         "-segment_list", listing, "-segment_list_type", "csv", os.path.join(work, "part%03d.mp3")],
        check=True,
    )
    parts = []
    with open(listing, newline="") as f:
        for name, start, end in csv.reader(f):
            parts.append((os.path.join(work, name), float(start), float(end)))
    os.remove(src)

    cues, boundaries, jumps = [], 0, 0
    prev_end = None
    for i, (path, start, end) in enumerate(parts):
        segs = whisper(path)
        os.remove(path)
        first = True
        for s in segs:
            a = start + float(s.get("start", 0))
            b = start + float(s.get("end", 0))
            text = " ".join(str(s.get("text", "")).split())
            if not text:
                continue
            # 切れ目の確かめ：区切りの外へ出る・前の区切りより戻るものを数える
            if a < start - 2 or a > end + 2:
                jumps += 1
            if first and prev_end is not None:
                boundaries += 1
                if a < prev_end - 1:
                    jumps += 1
            first = False
            b = min(max(b, a + 0.5), end + 1)
            cues.append((a, b, text))
            prev_end = b
    if not cues:
        raise RuntimeError("文字起こしが空")
    vtt = "WEBVTT\n\n" + "\n".join(f"{n}\n{stamp(a)} --> {stamp(b)}\n{t}\n" for n, (a, b, t) in enumerate(cues, 1))
    minutes = round(total / 60, 1)
    r = call("POST", "/transcribe/put?id=" + requests.utils.quote(row["id"], safe=""), json={"vtt": vtt, "minutes": minutes})
    if not r.ok:
        raise RuntimeError(f"返せない（{r.status_code}）")
    return {"minutes": minutes, "parts": len(parts), "boundaries": boundaries, "jumps": jumps, "naming": r.json().get("naming")}


def main() -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        call("POST", "/transcribe/report", json={"sent": 0, "ok": 0, "failed": 0, "minutes": 0, "boundaries": 0, "jumps": 0, "note": "OPENAI_API_KEY が無い"})
        sys.exit("OPENAI_API_KEY が無い")
    n = limit()
    nx = call("GET", f"/transcribe/next?limit={n}")
    nx.raise_for_status()
    got = nx.json()
    rows = got.get("rows") or []
    print(f"対象 {len(rows)} 本（残り {got.get('remaining')} 本・ここまでの費用 ${got.get('usd')}）{got.get('stop') or ''}")
    run = {"sent": 0, "ok": 0, "failed": 0, "minutes": 0.0, "boundaries": 0, "jumps": 0}
    for i, row in enumerate(rows, 1):
        run["sent"] += 1
        with tempfile.TemporaryDirectory() as work:
            try:
                res = one(row, work)
                run["ok"] += 1
                run["minutes"] += res["minutes"]
                run["boundaries"] += res["boundaries"]
                run["jumps"] += res["jumps"]
                print(f"{i}. {row['date']} {res['minutes']} 分・{res['parts']} 区切り・切れ目 {res['boundaries']}・飛び戻り {res['jumps']}・題名 {res['naming']}")
            except Exception as e:  # 1 本の失敗で全体を止めない
                run["failed"] += 1
                msg = str(e)[:200]
                print(f"{i}. {row['date']} 失敗：{msg}")
                try:
                    call("POST", "/transcribe/put?id=" + requests.utils.quote(row["id"], safe=""), json={"error": msg})
                except Exception:
                    pass
                if "鍵が使えない" in msg:
                    break
        # 費用の上限は zoom-to-youtube 側が持つ。届いていたら次を渡さないので、1 本ごとに聞き直す
        if i < len(rows):
            chk = call("GET", "/transcribe/next?limit=1").json()
            if chk.get("stop"):
                print(chk["stop"])
                break
    run["minutes"] = round(run["minutes"], 1)
    call("POST", "/transcribe/report", json=run)
    print(json.dumps(run, ensure_ascii=False))


if __name__ == "__main__":
    main()
