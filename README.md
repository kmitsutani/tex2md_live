# tex2md_live

LaTeX の原稿をドラッグ＆ドロップすると、Obsidian に貼れる Markdown を返すウェブアプリ。
**変換はすべてブラウザ内で完結し、ファイルはどこにも送信されない。**

> Drop a LaTeX paper onto the page and get Obsidian-ready Markdown back.
> Conversion runs entirely in the browser — the file never leaves your machine.
> No build step, no dependencies, no server.

共同研究の草稿に何が書いてあるかを、組版せずに読むために作った。
組版の結果ではなく**内容**が知りたい、という用途に向けている。

## 特徴

- `.tex` をウィンドウにドロップするだけ（ファイル選択・TeX の貼り付けも可）
- 左に元の TeX（行番号つき・コメントを種類別に色分け）、右に生成 Markdown
- **右ペインはそのまま編集できる**。直してからコピーできる
- クリップボードへコピー、`.md` として保存
- 変換レポート（未解決の `\cite` / `\ref`、解釈できなかった命令など）
- 依存パッケージ・ビルドステップ・バックエンドのいずれも無し

## 使い方

### 1. Windows デスクトップアプリとして使う

```bash
npm install
npm start          # デスクトップアプリが起動します
```

単一のポータブル実行ファイル（`.exe`）をビルドする場合：
```bash
npm run build:exe  # dist/ に tex2md_live-<version>-windows-portable.exe が生成されます
```

### 2. ウェブサーバで配信してブラウザで使う

`public/` を任意の静的ウェブサーバで配信するだけ。

```bash
git clone <this repo>
cd tex2md_live
npm run serve     # http://localhost:8099/
```

`python3 -m http.server 8099 --directory public` と等価。
Apache や nginx の下に置く場合も `public/` をそのまま配信すればよい
（アセットはすべて相対パスなので、サブパス配信でも動く）。

ES モジュールを使うため `file://` で直接開くことはできない。何らかの HTTP 配信が要る。

## 設計方針

### 組版情報は捨て、論理構造だけ拾う

`\Large` `\vspace` `\baselineskip` `\color` `\thispagestyle` `\scalebox` などは破棄する。
節・abstract・リスト・図表・数式・参考文献は残す。

### `%` コメントは種類を見分けて残す

実際の原稿では、飾り罫・コメントアウトされたコード・著者のメモが `%` の後ろに混在している。
同じように扱うと出力がノイズに埋もれるため、分類して出し分ける。

| 種別 | 例 | 既定の出力 |
|------|-----|-----------|
| 飾り罫 | `%%%%%%%%%%`, `%-------` | 破棄 |
| バナー見出し | `%%%%% Abstract %%%%%` | 破棄 |
| コメントアウトされた TeX | `%\usepackage{cite}` | 折りたたみコードブロック |
| 散文メモ | `% ここは要確認` | `> [!note]` コールアウト |

ヘッダのドロップダウンで「全部そのまま／散文メモのみ／出力しない」に切替できる。

### なぜ pandoc ではないのか

pandoc の LaTeX リーダーは優秀だが、**`%` コメントを黙って捨てる**。
草稿の把握という用途では、著者のメモやコメントアウトされた図も本文と同じくらい重要な情報になる。
このため自前のパーサを実装している。

## Obsidian 向けの変換

- 数式は MathJax 前提。`$$` は独立行に置き、`align` などは環境ごと `$$` で囲む
- **プリアンブルのユーザ定義マクロを展開する。** Obsidian にプリアンブルは無いため、
  `\newcommand` / `\def` / `\DeclareMathOperator` を展開しないと数式が壊れる。
  誌名マクロのような本文中のマクロも展開する
- **MathJax が解さないコマンドを書き換える。** `slashed` パッケージの `\slashed{}` は
  `\not{}` に、`bm` の `\bm{}` は `\boldsymbol{}` に
- `\numberwithin{equation}{section}` を尊重して式番号を振り、`\label` を `\tag` に、
  `\ref` を番号に解決する（LaTeX の規約どおり `\ref` は番号のみ、`\eqref` が括弧を付ける）
- `\footnote` は `[^n]`、`thebibliography` は `## References` のリストになる
- `figure` / `table` は再現できないため、caption・画像ファイル名・label をコールアウトに残す
- Obsidian 独自の `%%コメント%%` 構文は**使わない**（閲覧モードで非表示になり、
  コメントを見せるという目的と逆になる）

## 制約と注意

### クリップボードと secure context

`navigator.clipboard` は **secure context（HTTPS または localhost）でしか使えない**。
平文 HTTP の LAN ホストや VPN 名で配信すると、この API は**存在しない**。

そのためコピーは 3 段のフォールバックで実装してある（`public/js/clipboard.js`）。

1. `navigator.clipboard.writeText()`
2. textarea を選択して `document.execCommand('copy')`
3. 全選択して「Ctrl+C を押してください」と表示

`localhost` は secure context 扱いなので、**ローカル開発では 1 段目が通ってしまい
この問題は再現しない**。実際に配信するホストで確認すること。

### 変換は best-effort

未知の命令で落ちることはないが、黙って捨てることもしない。
捨てたもの・解決できなかったものは画面下の「変換レポート」に出る。
レポートには使用エンコーディング・読み込まれていたパッケージ・コメントの内訳・
**対応する `\bibitem` が無い引用**・**対応する `\label` が無い参照**・
解釈できなかった命令が並ぶ。原稿の不整合を見つける用途にも使える。

完全な LaTeX 処理系ではない。TikZ や XY-pic の図、複雑なマクロ、
独自クラスファイルに強く依存した文書は苦手。

## 開発

```bash
npm test          # 80 テスト（依存ゼロ、node --test）+ ゴールデン比較
npm run golden    # 出力を意図的に変えたときにゴールデンを再生成
npm run typecheck # JSDoc 型注釈の検査（tsc --noEmit、成果物なし）
npm run serve     # http://localhost:8099/ で public/ を配信
```

`npm install` は不要。実行時・開発時とも依存パッケージは無い
（`typecheck` だけ `npx` 経由で TypeScript を一時取得する）。

### 構成

```
public/
  index.html  styles.css
  js/
    main.js         UI（ドロップ・2ペイン・設定・コピー）
    clipboard.js    コピーの3段フォールバック
    decode.js       UTF-8 / Shift_JIS / EUC-JP の判定
    comments.js     % の抽出と分類
    lexer.js        走査プリミティブ
    parser.js       LaTeX → ノード木
    macros.js       ユーザ定義マクロの収集と展開
    mathshim.js     MathJax 非対応コマンドの書き換え
    markdown.js     ノード木 → Obsidian Markdown
    diagnostics.js  変換レポート
```

設計の背景は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照。

### テストデータ

`tests/data/sample.tex` は**架空の文書**で、実在の人物・組織・研究とは関係ない。
日本語の大学年次報告書によくある体裁を模しつつ、この変換器が対処すべき難所を
意図的に一通り詰め込んである。

飾り罫・コメントアウトされた図・`\title` を使わず `\begin{center}` に埋まった題名・
`\scalebox` による組版ノイズ・引数つきユーザマクロ・`align` と `\label` / `\ref`・
`\slashed` と `\bm`・数式を含む脚注・対応する `\bibitem` が無い `\cite`・
`description` リスト・`tabular`・`verbatim`・壊れた制御綴。

変換結果は `tests/data/sample.expected.md` にゴールデンとして固定してある。

## ライセンス

MIT License（[LICENSE](LICENSE) 参照）。
