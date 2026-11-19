"""
zoom-to-youtube / scripts/edit_sounds.py（第55版・2026-11-19 開発部・動画の自動編集 便 2）

自動編集で使う効果音 3 つと BGM 1 本を、数式から作る（外の素材サイトを使わないので権利の確認が要らない）。
作ったものは assets/edit/ に置いてリポジトリに入れる。作り直すときだけ動かす：
  python3 scripts/edit_sounds.py
  pop.wav   … B 強調の「ポン」
  jan.wav   … C キーワードの「ジャン」
  whoosh.wav… 上の帯が切り替わる「シュッ」
  bgm.flac  … 声の下で流す、落ち着いた明るめの 32 秒のループ（C → Am → F → G）
"""
import os
import wave

import numpy as np

SR = 48000
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "edit")


def save(name: str, x: np.ndarray, peak: float = 0.9) -> None:
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    st = np.stack([x, x], axis=1)
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((st * 32767).astype(np.int16).tobytes())


def env(n: int, attack: float, decay: float) -> np.ndarray:
    t = np.arange(n) / SR
    a = np.clip(t / attack, 0, 1)
    return a * np.exp(-t / decay)


def pop() -> np.ndarray:
    n = int(SR * 0.16)
    t = np.arange(n) / SR
    f = 620 + 900 * (1 - np.exp(-t / 0.02))  # 一瞬で上がる高さ
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) + 0.25 * np.sin(2 * ph)) * env(n, 0.002, 0.045)


def bell(freq: float, dur: float, decay: float) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n) / SR
    x = sum(a * np.sin(2 * np.pi * freq * m * t) for m, a in [(1, 1), (2, 0.45), (3, 0.2), (4.2, 0.12)])
    return x * env(n, 0.003, decay)


def jan() -> np.ndarray:
    n = int(SR * 0.9)
    x = np.zeros(n)
    for k, (f, at) in enumerate([(784, 0.0), (1047, 0.09)]):  # ソ → ド
        b = bell(f, 0.9 - at, 0.28 + 0.1 * k)
        s = int(at * SR)
        x[s:s + len(b)] += b
    return x


def whoosh() -> np.ndarray:
    n = int(SR * 0.42)
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n)
    t = np.arange(n) / SR
    # 帯域を低→高へ動かす（簡単な 2 次の共振）
    out = np.zeros(n)
    y1 = y2 = 0.0
    for i in range(n):
        fc = 400 + 3600 * (t[i] / t[-1]) ** 1.5
        r = 0.97
        w = 2 * np.pi * fc / SR
        y = noise[i] * (1 - r) + 2 * r * np.cos(w) * y1 - r * r * y2
        out[i] = y
        y2, y1 = y1, y
    shape = np.sin(np.pi * t / t[-1]) ** 2
    return out * shape


def note(freq: float, dur: float, vel: float) -> np.ndarray:
    n = int(SR * dur)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * t) + 0.08 * np.sin(2 * np.pi * freq * 3 * t)
    return vel * x * env(n, 0.01, 0.9)


def midi(m: int) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def bgm() -> np.ndarray:
    bpm, bars = 84, 16
    beat = 60 / bpm
    n = int(SR * beat * 4 * bars)
    x = np.zeros(n + SR * 2)
    chords = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]]  # C Am F G
    bass = [36, 33, 29, 31]
    for bar in range(bars):
        c = bar % 4
        t0 = bar * 4 * beat
        # 和音：拍の頭で柔らかく
        for b in range(4):
            s = int((t0 + b * beat) * SR)
            for m in chords[c]:
                v = note(midi(m), beat * 1.6, 0.10 if b else 0.14)
                x[s:s + len(v)] += v
        # ベース：1・3 拍
        for b in (0, 2):
            s = int((t0 + b * beat) * SR)
            v = note(midi(bass[c]), beat * 1.8, 0.35)
            x[s:s + len(v)] += v
        # 上の音：8 分で分散和音（控えめ）
        arp = chords[c] + [chords[c][1] + 12]
        for k in range(8):
            s = int((t0 + k * beat / 2) * SR)
            v = note(midi(arp[k % len(arp)] + 12), beat * 0.9, 0.04)
            x[s:s + len(v)] += v
    # 末尾のはみ出しを頭へ重ねて、継ぎ目のないループにする
    tail = x[n:]
    x = x[:n]
    x[: len(tail)] += tail
    # 簡単な残響（短い遅れを 3 つ）
    for d, g in [(0.031, 0.25), (0.053, 0.18), (0.097, 0.12)]:
        k = int(d * SR)
        x[k:] += g * x[:-k]
    return x


if __name__ == "__main__":
    save("pop.wav", pop(), 0.8)
    save("jan.wav", jan(), 0.8)
    save("whoosh.wav", whoosh(), 0.7)
    save("bgm.wav", bgm(), 0.6)
    # 継ぎ目が出ないよう可逆の flac にする（AAC は頭に無音が入る）
    os.system(f"ffmpeg -v error -y -i {OUT}/bgm.wav -c:a flac {OUT}/bgm.flac && rm {OUT}/bgm.wav")
    print("ok")
