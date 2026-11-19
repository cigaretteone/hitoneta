# きょうのひとネタ（テスト版）

毎日届くなぞなぞ・クイズを、LINEなどで家族や友だちに送って会話を生むアプリのテスト版（PWA）。

- 使い方：スマホで https://cigaretteone.github.io/hitoneta/ を開く。iPhoneはSafariの共有ボタン →「ホーム画面に追加」
- 声で答える：iPhoneはSafari、AndroidはChromeでマイクが使える
- ネタは見本データ。データはその端末の中だけで扱い、サーバーには送らない

更新時は `sw.js` の `VERSION` を上げること。

## 毎日の通知（αテスト）

- 通知の送信役は `worker/`（Cloudflare Workers・無料枠）。15分ごとに起動し、その時刻を登録した端末へ中身のない通知を送る
- 表示する問題は端末側の `sw.js` が選ぶ。送信役は問題の内容も利用者の情報も持たない（通知先と時刻だけ）
- `worker/` を変更して main にプッシュすると、GitHub Actions がデプロイする。必要なシークレット：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`KV_ID`、`VAPID_PRIVATE_JWK`
- iPhoneはSafariで「ホーム画面に追加」し、ホームのアイコンから開いたときだけ通知を登録できる（iOS 16.4以降）
