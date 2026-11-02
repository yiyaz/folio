import type { MarkdownConfig } from '@lezer/markdown';

/**
 * Teaches the Markdown parser about YAML front matter (a `---` fenced block at the very
 * start of the document). Without it, the opening fence parses as a horizontal rule and the
 * closing fence turns the YAML into a setext heading.
 */
export const Frontmatter: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false;
        const start = cx.lineStart;
        while (cx.nextLine()) {
          const t = line.text.trimEnd();
          if (t === '---' || t === '...') {
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt('Frontmatter', start, end));
            return true;
          }
        }
        // unterminated: treat the rest of the document as front matter, like most tools do
        cx.addElement(cx.elt('Frontmatter', start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};
