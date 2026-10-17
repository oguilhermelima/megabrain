/** The CLI's self-contained HTML skin, derived from apps/desktop/src/styles.css tokens. */
export const MEGABRAIN_ARTIFACT_THEME = `:root {
  color-scheme: dark;
  --paper: #000000;
  --surface: #0a0a0c;
  --surface-raised: #18181c;
  --rule: #303036;
  --ink: #f5f5f7;
  --muted: #8a8a94;
  --accent: #8e9cff;
  --ok: #34d399;
  --warn: #fbbf24;
  --bad: #fb7185;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --radius-card: 24px;
  --radius-panel: 32px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --paper: #f5f5f7;
    --surface: #ffffff;
    --surface-raised: #ececf0;
    --rule: #dcdce2;
    --ink: #18181c;
    --muted: #55555f;
    --accent: #5367d9;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: var(--space-8); background: var(--paper); color: var(--ink); font: 16px/1.6 var(--font-sans); }
main { width: min(100%, 960px); margin: 0 auto; }
section, article, .card { margin-block: var(--space-6); padding: var(--space-6); border: 1px solid var(--rule); border-radius: var(--radius-card); background: var(--surface); }
h1, h2, h3 { line-height: 1.2; }
a { color: var(--accent); }
code, pre { font-family: var(--font-mono); }
`;

/** Adds the local theme only when this HTML does not already carry it. */
export function applyMegabrainTheme(html: string): string {
  if (html.includes("id=\"megabrain-theme\"") || html.includes("id='megabrain-theme'")) return html;
  const style = `<style id="megabrain-theme">\n${MEGABRAIN_ARTIFACT_THEME}</style>\n`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${style}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}\n<head>\n${style}</head>`);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, (body) => `<head>\n${style}</head>\n${body}`);
  return `${style}${html}`;
}
