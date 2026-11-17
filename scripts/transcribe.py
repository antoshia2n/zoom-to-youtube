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
# 第50版：1 回の実行で新しい録画を取り始めるのは 300 分まで（実行の上限 340 分の手前）。残りは次の実行を自分で起こす
RUN_MINUTES = 300
STARTED = time.time()
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
    r = call("POST", "/transcribe/put?id=" + requests.utils.quote(row["id"], safe=""), json={"vtt": vtt, "minutes": minutes, "parts": len(parts), "boundaries": boundaries, "jumps": jumps}, timeout=300)
    if not r.ok:
        raise RuntimeError(f"返せない（{r.status_code}）")
    return {"minutes": minutes, "parts": len(parts), "boundaries": boundaries, "jumps": jumps, "naming": r.json().get("naming")}


CHAT = "https://api.openai.com/v1/chat/completions"
CLEAN_MODEL = "gpt-5-mini"
CLEAN_RULES = """あなたは日本語の編集者です。入力は話し言葉の文字起こしの一部です（各行：秒｜話者｜本文）。
これを、話した中身をそのまま残した読み物に整えてください。
- 「えー」「あのー」「なんか」などの言いよどみ、同じ言葉のくり返し、言い直しの前半を取る
- 句読点を正しく打ち、話の区切りで段落に分ける（1 段落は 2〜6 文ほど）
- 文脈から明らかな聞き間違い・変換の誤りだけ直す。迷うものは直さない
- 話の中身を足さない・削らない・要約しない・言い換えて意味を変えない
- 話者の名前（シアニン・参加者 N）と「（名前）」はそのまま使う。新しい名前を作らない
- 段落の t は、その段落が始まる行の秒をそのまま入れる（入力にある数字だけを使う）
- 話者が変わったら段落を分ける
出力は JSON だけ：{"paras":[{"t":秒,"w":"話者","x":"本文"}]}"""


def clean_chunk(lines: list) -> tuple:
    text = "\n".join(f"{int(c['t'])}｜{c.get('w') or '-'}｜{c['x']}" for c in lines)
    last = ""
    for attempt in range(4):
        r = requests.post(
            CHAT,
            headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]},
            json={"model": CLEAN_MODEL, "reasoning_effort": "minimal", "response_format": {"type": "json_object"},
                  "messages": [{"role": "system", "content": CLEAN_RULES}, {"role": "user", "content": text}]},
            timeout=600,
        )
        if r.ok:
            j = r.json()
            u = j.get("usage") or {}
            try:
                paras = json.loads(j["choices"][0]["message"]["content"]).get("paras") or []
            except Exception:
                last = "答えが JSON で読めない"
                continue
            return paras, int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)
        last = f"OpenAI {r.status_code}"
        if r.status_code in (401, 403):
            raise RuntimeError(last + "（鍵が使えない）")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(last)


def clean_one(row: dict) -> dict:
    q = requests.utils.quote(row["id"], safe="")
    src = call("GET", "/transcribe/clean-src?id=" + q, timeout=300)
    if not src.ok:
        raise RuntimeError(f"文字起こしを受け取れない（{src.status_code}）")
    cues = src.json().get("cues") or []
    if not cues:
        raise RuntimeError("文字起こしが空")
    # 10 分ごとに区切って送る（長い回でも 1 回の答えが切れないように）
    chunks, cur, start = [], [], cues[0]["t"]
    for c in cues:
        if cur and c["t"] - start >= SEG:
            chunks.append(cur)
            cur, start = [], c["t"]
        cur.append(c)
    if cur:
        chunks.append(cur)
    paras, tin, tout = [], 0, 0
    valid_t = {int(c["t"]) for c in cues}
    for ch in chunks:
        p, a, b = clean_chunk(ch)
        tin += a
        tout += b
        lo, hi = int(ch[0]["t"]), int(ch[-1]["t"])
        for x in p:
            try:
                t = int(float(x.get("t", lo)))
            except (TypeError, ValueError):
                t = lo
            # 時刻は入力にある秒だけ。外れたらその区切りの範囲に収める
            if t not in valid_t:
                t = min(max(t, lo), hi)
            body = " ".join(str(x.get("x", "")).split())
            if body:
                paras.append({"t": t, "w": str(x.get("w") or ""), "x": body})
    paras.sort(key=lambda p: p["t"])
    raw = sum(len(c["x"]) for c in cues)
    ratio = (sum(len(p["x"]) for p in paras) / raw) if raw else 0
    r = call("POST", "/transcribe/clean-put?id=" + q, json={"paras": paras, "in_tokens": tin, "out_tokens": tout, "ratio": ratio, "date": row["date"]}, timeout=300)
    if not r.ok:
        raise RuntimeError(f"返せない（{r.status_code}）")
    return {"paras": len(paras), "ratio": round(ratio, 2), "chunks": len(chunks)}


def main_clean() -> None:
    n = limit()
    ids = (os.environ.get("IDS_INPUT") or "").strip()
    if not ids:
        try:
            with open(".github/transcribe-request.json", encoding="utf-8") as f:
                ids = ",".join(json.load(f).get("ids") or [])
        except Exception:
            ids = ""
    path = f"/transcribe/clean-next?limit={n}" + ("&ids=" + requests.utils.quote(ids, safe="") if ids else "")
    got = call("GET", path, timeout=300).json()
    rows = got.get("rows") or []
    print(f"整えた版 対象 {len(rows)} 本（残り {got.get('remaining')} 本・今月 ${got.get('usd_month')}）{got.get('stop') or ''}")
    done = timed_out = 0
    for i, row in enumerate(rows, 1):
        if (time.time() - STARTED) / 60 > RUN_MINUTES:
            timed_out = 1
            break
        try:
            res = clean_one(row)
            done += 1
            print(f"{i}. {row['date']} 段落 {res['paras']}・区切り {res['chunks']}・長さの比 {res['ratio']}")
        except Exception as e:
            msg = str(e)[:200]
            print(f"{i}. {row['date']} 失敗：{msg}")
            try:
                call("POST", "/transcribe/clean-put?id=" + requests.utils.quote(row["id"], safe=""), json={"error": msg})
            except Exception:
                pass
            if "鍵が使えない" in msg:
                break
        try:
            if call("GET", "/transcribe/clean-budget", timeout=60).json().get("stop"):
                print("今月の上限に届いた")
                break
        except Exception:
            pass
    left = n - i if rows else 0
    if timed_out and done and left > 0:
        chain(left, "clean")


def main() -> None:
    if (os.environ.get("MODE_INPUT") or "").strip() == "clean" or request_mode() == "clean":
        main_clean()
        return
    if not os.environ.get("OPENAI_API_KEY"):
        call("POST", "/transcribe/report", json={"sent": 0, "ok": 0, "failed": 0, "minutes": 0, "boundaries": 0, "jumps": 0, "note": "OPENAI_API_KEY が無い"})
        sys.exit("OPENAI_API_KEY が無い")
    n = limit()
    nx = call("GET", f"/transcribe/next?limit={n}", timeout=300)
    nx.raise_for_status()
    got = nx.json()
    rows = got.get("rows") or []
    print(f"対象 {len(rows)} 本（残り {got.get('remaining')} 本・ここまでの費用 ${got.get('usd')}）{got.get('stop') or ''}")
    run = {"sent": 0, "ok": 0, "failed": 0, "minutes": 0.0, "boundaries": 0, "jumps": 0}
    timed_out = False
    for i, row in enumerate(rows, 1):
        if (time.time() - STARTED) / 60 > RUN_MINUTES:
            timed_out = True
            print(f"{RUN_MINUTES} 分を過ぎたので、ここで切って次の実行へ渡す")
            break
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
            try:
                chk = call("GET", "/transcribe/budget", timeout=60).json()
            except Exception as e:
                print("費用の確かめに失敗：" + type(e).__name__)
                chk = {}
            if chk.get("stop"):
                print(chk["stop"])
                run["note"] = "費用の上限で止めた"
                break
    run["minutes"] = round(run["minutes"], 1)
    left = n - run["sent"]
    if timed_out and run["ok"] > 0 and left > 0 and not run.get("note"):
        run["note"] = f"続きを起こした（あと {left} 本まで）"
        chain(left)
    call("POST", "/transcribe/report", json=run)
    print(json.dumps(run, ensure_ascii=False))


def request_mode() -> str:
    if (os.environ.get("MODE_INPUT") or "").strip():
        return os.environ["MODE_INPUT"].strip()
    if (os.environ.get("LIMIT_INPUT") or "").strip():
        return "transcribe"
    try:
        with open(".github/transcribe-request.json", encoding="utf-8") as f:
            return str(json.load(f).get("mode") or "transcribe")
    except Exception:
        return "transcribe"


def chain(left: int, mode: str = "transcribe") -> None:
    # 自分の実行の鍵（GITHUB_TOKEN）で workflow_dispatch を 1 回だけ起こす
    r = requests.post(
        "https://api.github.com/repos/antoshia2n/zoom-to-youtube/actions/workflows/transcribe.yml/dispatches",
        headers={"Authorization": "Bearer " + os.environ.get("GITHUB_TOKEN", ""), "Accept": "application/vnd.github+json"},
        json={"ref": "main", "inputs": {"limit": str(min(300, left)), "mode": mode}},
        timeout=30,
    )
    print(f"続きの実行を起こした：{r.status_code}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # 途中で止まったら、理由だけを控えへ（中身は出さない）
        msg = f"{type(e).__name__}: {str(e)[:200]}"
        print("止まった：" + msg)
        try:
            call("POST", "/transcribe/report", json={"sent": 0, "ok": 0, "failed": 0, "minutes": 0, "boundaries": 0, "jumps": 0, "note": msg})
        except Exception:
            pass
        sys.exit(1)
