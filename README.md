# GitHub Sync for Obsidian

iOS で安定して動くことを目的とした Obsidian 用の git クライアント。

## なぜ作ったか

[obsidian-git](https://github.com/Vinzent03/obsidian-git) はモバイルで [isomorphic-git](https://isomorphic-git.org/)（純 JS の git 実装）を使っており、作者自身が README で "The Git implementation on mobile is **very unstable**" と明言している。clone/pull でのクラッシュや buffer overflow が起きるが、JS 実装の非効率さが原因なので直せない、とも書かれている。

原因はリポジトリのサイズではなく実装方式にある。

1. packfile の展開・生成を JS で行う
2. 変更検出のたびに全ファイルを読んで SHA-1 する処理が、iOS の Capacitor ファイルブリッジ越しに走る

同じ方式で作り直しても同じ壁に当たるため、**git プロトコルを喋らない**方向に振った。

## 仕組み

端末に `.git` を持たない。代わりに GitHub の Git Data API でコミットを組み立てる。

- **変更検出**: ファイルの `mtime` と `size` が前回と同じならハッシュを使い回す。実際に読むのは変更されたファイルだけ
- **push**: 変更ファイルの blob を作り、`base_tree` からの差分でツリーを作り、コミットを作る。最後に一度だけ ref を進める
- **pull / ブランチ切替 / clone**: どれも「2つのツリー（`path -> blob SHA` のマップ）の差分を取り、違うファイルだけを1件ずつ書く」に還元される。メモリ使用量がファイル数に比例しない

`clone` は「空のマップとの差分」でしかないので、専用のコードパスを持たない。

## 認証 — PAT を使わない

GitHub App の **OAuth Device Flow** を使う。

device flow は client secret を必要としない（公開情報の `client_id` だけで完結する）。さらに GitHub は「device flow で発行したトークンのリフレッシュにも client secret は不要」としているため、**サーバーを1台も持たずに「8時間で失効するトークン + 自動更新」が成立する**。

初回だけ 8 桁のコードを `github.com/login/device` に入力する。以降は自動。

このプラグインは特定の GitHub App を持たない。**利用者が自分の App を作って、その Client ID を設定に入れる。**

## セットアップ

### 1. GitHub App を作る（1回だけ）

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**

| 項目 | 設定 |
|---|---|
| GitHub App name | 任意（全体で一意） |
| Homepage URL | 任意（このリポジトリの URL でよい） |
| Callback URL | 空のまま |
| Expire user authorization tokens | チェックしたまま（8時間失効 + 自動更新） |
| Request user authorization (OAuth) during installation | 外す |
| **Enable Device Flow** | **必ずチェック** |
| Webhook → Active | 外す |
| Repository permissions | **Contents: Read and write** だけ。他は No access |
| Where can this GitHub App be installed? | Only on this account |

作成後、**Client ID** を控える。client secret は作らなくてよい。

左メニュー **Install App** → 自分のアカウント → **Only select repositories** → 同期したい vault のリポジトリだけを選んで Install。

### 2. プラグインを入れる

[BRAT](https://github.com/TfTHacker/obsidian42-brat) の Add Beta Plugin に `KentaMaeda0916/obsidian-github-sync` を入力して有効化する。

### 3. 設定する

プラグインの設定で

1. **GitHub App の Client ID** に 1 で控えた値
2. **リポジトリ** に `owner/repo`
3. **GitHub と接続** → 表示された 8 桁のコードを `github.com/login/device` に入力して承認
4. **クローン**（空の vault に展開する。初回だけ）

トークンは `.obsidian/plugins/obsidian-github-sync/data.json` に保存される。`.obsidian` は同期対象から外れているので、リポジトリには入らない。

### うまくいかないとき

**「リポジトリ … にアクセスできません」** — GitHub は認証が通っていてもリポジトリが見えない場合、その存在を隠すため 404 を返す。原因は次のどれか。

- 設定の `owner/repo` が違う（Organization のリポジトリなら owner は Organization 名）
- 1 で作った GitHub App を、そのリポジトリに **install** していない。App を作るだけでは足りない
- App の Repository permissions で Contents が Read and write になっていない。後から変えた場合は再接続が必要

**「ブランチ … がリモートにありません」** — こちらはリポジトリには到達できている。メッセージに実際にあるブランチ名が出るので、既定ブランチが `master` だった等を確認する。

## しないこと

- 3-way マージ。未コミットの変更がリモートの変更と重なった場合は、何もせず中断する
- rebase / stash / submodule / LFS
- ローカルの履歴（`git log`）。GitHub 側で見る

## 開発

```bash
npm install
npm run dev        # watch ビルド
npm run build      # typecheck + 本番ビルド

# blob ハッシュが本物の git と一致するか確認する
node scripts/verify-hash.mjs <ファイル...>
```

リリースはタグを push すると GitHub Actions が作る（BRAT はリリースアセットからしか読まないため）。

```bash
npm version patch && git push --follow-tags
```

## ライセンス

MIT
