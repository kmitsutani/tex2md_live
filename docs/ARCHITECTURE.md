# Architecture

## なぜ自前のパーサなのか

pandoc 3.1.3 は導入済みで `-f latex -t markdown` も使えるが、採用していない。決め手は
**pandoc が `%` コメントを黙って捨てる**こと。草稿の把握という用途では、著者のメモや
コメントアウトされた図は本文と同じくらい重要な情報になる。

加えて実際の原稿には pandoc が素通しできない要素が普通に含まれる:
`slashed` のような描画系パッケージ、手書きの `thebibliography`、
`\title` を使わず `\begin{center}` に埋め込まれた題名、壊れた制御綴。
これらは `tests/data/sample.tex`（架空の文書）に再現してある。

## パイプライン

```
bytes
  │  decode.js        UTF-8 → Shift_JIS → EUC-JP を順に試す
  ▼
text
  │  comments.js      % を抽出し 4 種に分類、跡地に \TPC{n} を残す
  ▼
text + comment table
  │                   \begin{document} で preamble / body に分割
  │  macros.js        preamble から \newcommand 等を収集
  │  parser.js        body → ノード木（lexer.js のプリミティブを使用）
  ▼
node tree
  │  markdown.js      1st pass: 式番号とラベル・文献キーを収集
  │                   2nd pass: Markdown を生成
  │    └ macros.js    数式内のユーザマクロを展開
  │    └ mathshim.js  MathJax 非対応コマンドを書き換え
  ▼
Markdown + diagnostics.js
```

## 設計上の判断

**コメントを先に抜く。** `%` は TeX の字句レベルの機能で、数式の途中にも現れる。
トークナイズ前に処理しないと正しく扱えない。escape (`\%`) と `\verb`、
verbatim 環境内のリテラル `%` は除外する。

**跡地にセンチネルを残す。** コメントを単に消すと位置情報が失われる。
`\TPC{n}` という合成コマンドを置くことで、パーサが構造上の位置を保ち、
レンダラが正しい場所にコールアウトを出せる。数式の中に入ってしまったものは
数式の**後ろ**に繰り上げる（式の途中にコールアウトは置けないため）。

**数式は解析せず生のまま持つ。** MathJax に渡すのは著者が書いたものそのものが良い。
パーサは `$...$`・`\[...\]`・math 環境の中身を文字列として捕まえるだけにする。

**パーサは絶対に落とさない。** 入力は同僚の作業中の草稿で、構文的に壊れていることがある。
未知のコマンド・閉じていない環境・釣り合わない波括弧はすべて許容し、
捨てたものは diagnostics に記録する。

**2 パスにする。** `\ref` は `\label` より前に現れうるので、
式番号とラベルの収集を先に済ませてから本文を生成する。

**フォント切替はグループ内でのみ効かせる。** `{\bf 著者名}` は太字にしたいが、
`\begin{document}` 直後に裸の `\Large\bf` が置かれている原稿は珍しくなく、
それで文書全体が太字になっては困る。グループの外の切替は無視する。

## 型

型注釈は JSDoc で書き、`npm run typecheck` で `tsc --noEmit` にかける。
成果物は出ないので、ブラウザは `.js` をそのまま読む。
`node_modules` もビルドステップも持たない。
