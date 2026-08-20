# zoom-to-youtube

Zoom のクラウド録画を Google ドライブと YouTube へ運ぶ処理。

## 口

| 口 | 何をするか |
|---|---|
| `GET /setup/sheet` | 管理用スプレッドシートを1枚作る（すでにあれば作らない） |
| `GET /run` | シートの未処理の行を1本ずつ通す。途中経過が流れる |
| `GET /oauth/start` | 許可を通す（2本に分かれている） |
| `GET /oauth/status` | 許可とシートの状態を見る |
| `GET /probe?share=...&mode=drain` | Zoom からの転送を測る |

5分ごとの自動実行が `/run` と同じ処理を静かに動かす。重ならないよう R2 に錠を置く。

## 処理の流れ

1. シートの `Zoom共有URL` が入っていて `処理状態` が空か `未処理` の行を拾う
2. Zoom の共有リンクから、動画の場所・文字起こし・収録の日時を取る
3. ドライブに `講義コンテンツ/{年}/{年月}/{収録日}_{講義タイトル}` を作る
4. 文字起こし（.vtt）を保存する
5. 動画を 8 MB ずつ Zoom から読んでドライブへ渡す
6. 同じやり方で YouTube へ渡す（限定公開で依頼する）
7. シートに Drive の URL・YouTube の URL・状態を書き戻す

失敗したら `処理状態` を `エラー` にして、`エラー内容` に日本語で理由を書く。

## 公開設定について

YouTube は、監査を受けていない API プロジェクトから上げた動画を非公開に制限することがある。
2026-08-20 に、この チャンネル では上げたあと 限定公開 に変えても戻されないことを実物で確認した
（固定は掛かっていない）。そこで最初から `unlisted`（限定公開）で頼む。

YouTube 側が非公開にした場合は、`処理状態` は `完了` のまま `エラー内容` に
「手で 限定公開 に変えてください」と入る。悪くなることはない。

## 動画を溜め込まない理由

Workers のメモリは 128 MB。159 MB の動画を丸ごと持つと足りない。
Zoom は途中からの読み出し（Range）に対応しているので、8 MB ずつ読んで
そのまま Google の受け口へ渡す。手元に残るのは常に 8 MB だけ。

## 許可が2本に分かれている理由（どちらも実物で確認）

- Google は YouTube の許可とドライブの許可を1回の要求にまとめられない
  （`This request contains scopes that cannot be requested together`）
- ブランドアカウントは YouTube 以外の Google のサービスを使えないため、
  `openid` / `email` を混ぜると「サービスをご利用いただけません」で止まる
- `youtube.upload` だけでは channels.list が 403 になるので `youtube.readonly` も取る

置き場：

- `auth/workspace.json` … ドライブとシート（ALLOWED_EMAIL で本人確認）
- `auth/youtube.json` … YouTube（チャンネル名と ID で本人確認。別チャンネルでは上書きしない）
- `config/sheet.json` … 管理用シートの番号
- `run/lock` … 同時に走らないための錠

## 必要な設定

Settings → Variables and Secrets に **Type: Secret** で3つ。

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `ALLOWED_EMAIL`

R2 バケット `zoom-to-youtube` を binding 名 `STORE` で使う。

## 反映のしかた

main に上げると Cloudflare が自動で作り直す。Build command `npm install` / Deploy command `npx wrangler deploy`。
