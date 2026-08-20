# zoom-to-youtube

Zoom のクラウド録画を Google ドライブと YouTube へ運ぶ処理を置く場所。

## いまの版（第2版・2026-08-20）

測定の口と、Google の許可を取る口まで。まだ動画は運びません。

| 口 | 何をするか |
|---|---|
| `GET /` | 使い方を表示 |
| `GET /oauth/start` | 許可の通し方を表示（2本に分かれています） |
| `GET /oauth/start?for=youtube` | YouTube の許可を取る |
| `GET /oauth/start?for=workspace` | ドライブとシートの許可を取る |
| `GET /oauth/callback` | 許可を受け取って控えを保存する（Google の画面に登録した戻り先） |
| `GET /oauth/status` | 許可が生きているかを見る（秘密の値は表示しない） |
| `GET /probe?share=...` | Zoom の録画の情報を取る |
| `GET /probe?share=...&mode=drain` | 動画の本体を読み切って時間を測る |

## 許可が2回に分かれている理由（どちらも実物で確認）

Google は YouTube の許可（youtube.upload）と ドライブ の許可（drive.file）を
同じ1回の要求でまとめて出せません。まとめて求めると
`This request contains scopes that cannot be requested together` が返ります
（2026-08-20 に実物で確認）。そのため許可を2回に分け、控えも別々に保存します。

さらに、上げ先のチャンネルがブランドアカウントの場合、そのアカウントは
YouTube 以外の Google のサービスを使えません。`openid` や `email` を混ぜると
「サービスをご利用いただけません」で止まります（2026-08-20 に実物で確認）。
そのため YouTube の側は `youtube.upload` だけを求めます。

- `auth/youtube.json` … YouTube の控え（ブランドアカウント。チャンネル名と ID で本人確認）
- `auth/workspace.json` … ドライブとシートの控え（ふだんの Google アカウント。ALLOWED_EMAIL で本人確認）

YouTube 側はメールアドレスが取れないため、**最初に登録したチャンネルと違うチャンネルの
許可が来た場合は上書きしない**（409 を返す）作りにしています。

## 必要な設定

Cloudflare の Workers の画面 → Settings → Variables and Secrets に、**Type: Secret** で3つ。

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `ALLOWED_EMAIL`（この住所以外の Google アカウントでは許可を受け付けない）

R2 の置き場 `zoom-to-youtube` を binding 名 `STORE` で使います。

## 反映のしかた

このリポジトリの main に上げると、Cloudflare 側が自動で作り直して反映します。

- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: 空欄

## 消す予定のもの

`/probe` の口は、段階 B の本処理を入れる回に消します。共有リンクを持つ人なら誰でも叩ける状態のためです。
