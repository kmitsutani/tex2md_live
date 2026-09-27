/**
 * Conversion diagnostics.
 *
 * The point of this app is understanding a draft, so what the converter could
 * NOT resolve is itself useful information. A paper that cites `\cite{KR}`
 * while its bibliography defines `K-R` has an inconsistency the reader should
 * know about, and only the converter is in a position to notice it.
 */

export class Diagnostics {
  constructor() {
    /** @type {string} */
    this.encoding = 'utf-8';
    /** @type {boolean} */
    this.encodingFallback = false;
    /** @type {string[]} */
    this.packages = [];
    /** @type {Map<string, number>} */
    this.unknownCommands = new Map();
    /** @type {Set<string>} */
    this.unresolvedCites = new Set();
    /** @type {Set<string>} */
    this.unresolvedRefs = new Set();
    /** @type {Map<string, number>} */
    this.droppedEnvironments = new Map();
    /** @type {Record<string, number>} */
    this.commentCounts = { note: 0, code: 0, banner: 0, decoration: 0 };
    /** @type {string[]} */
    this.notes = [];
  }

  /** @param {string} name */
  unknownCommand(name) {
    this.unknownCommands.set(name, (this.unknownCommands.get(name) ?? 0) + 1);
  }

  /** @param {string} name */
  droppedEnvironment(name) {
    this.droppedEnvironments.set(name, (this.droppedEnvironments.get(name) ?? 0) + 1);
  }

  /** @param {string} message */
  note(message) {
    if (!this.notes.includes(message)) this.notes.push(message);
  }

  /** Whether anything worth the user's attention was recorded. */
  get hasFindings() {
    return (
      this.unresolvedCites.size > 0 ||
      this.unresolvedRefs.size > 0 ||
      this.unknownCommands.size > 0 ||
      this.notes.length > 0
    );
  }

  /**
   * Human-readable summary, used by the UI panel.
   * @returns {{label: string, items: string[]}[]}
   */
  sections() {
    const out = [];

    const enc = this.encodingFallback
      ? `${this.encoding}（UTF-8 として読めなかったため推定）`
      : this.encoding;
    out.push({ label: '文字エンコーディング', items: [enc] });

    if (this.packages.length > 0) {
      out.push({ label: '読み込まれていたパッケージ', items: [this.packages.join(', ')] });
    }

    const comments = Object.entries(this.commentCounts)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${COMMENT_LABELS[kind] ?? kind}: ${n}`);
    if (comments.length > 0) out.push({ label: 'コメントの内訳', items: comments });

    if (this.unresolvedCites.size > 0) {
      out.push({
        label: '対応する \\bibitem が無い引用',
        items: [...this.unresolvedCites].map((k) => `\\cite{${k}}`),
      });
    }

    if (this.unresolvedRefs.size > 0) {
      out.push({
        label: '対応する \\label が無い参照',
        items: [...this.unresolvedRefs].map((k) => `\\ref{${k}}`),
      });
    }

    if (this.unknownCommands.size > 0) {
      const sorted = [...this.unknownCommands.entries()].sort((a, b) => b[1] - a[1]);
      out.push({
        label: '解釈できなかった命令',
        items: sorted.map(([name, n]) => `\\${name}${n > 1 ? ` ×${n}` : ''}`),
      });
    }

    if (this.droppedEnvironments.size > 0) {
      const sorted = [...this.droppedEnvironments.entries()].sort((a, b) => b[1] - a[1]);
      out.push({
        label: '中身だけ残した環境',
        items: sorted.map(([name, n]) => `${name}${n > 1 ? ` ×${n}` : ''}`),
      });
    }

    if (this.notes.length > 0) out.push({ label: '備考', items: this.notes });

    return out;
  }
}

const COMMENT_LABELS = {
  note: '散文メモ',
  code: 'コメントアウトされた TeX',
  banner: 'バナー見出し',
  decoration: '飾り罫（破棄）',
};
