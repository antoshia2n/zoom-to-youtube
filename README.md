# zoom-to-youtube

Zoom のクラウド録画を Google ドライブと YouTube へ運ぶ処理を置く場所。

## いまの版（第1版・2026-08-20）

**測るだけ。**Google ドライブにも YouTube にも何も書きません。秘密の値の設定も不要です。

- `GET /probe?share=<Zoom の共有リンク>` … 録画の情報と文字起こしを取る（数秒）
- `GET /probe?share=<Zoom の共有リンク>&mode=drain` … 動画の本体も読み切って時間を測る

## 反映のしかた

このリポジトリの main に上げると、Cloudflare 側が自動で作り直して反映します。

- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: 空欄

## この版で消す予定のもの

`/probe` の口は、測り終わったら消します（段階 B の実装を入れる回）。
公開の置き場なので、共有リンクを持っている人なら誰でも叩ける状態にあります。
測定は今日のうちに終わらせ、同じ日に閉じます。
