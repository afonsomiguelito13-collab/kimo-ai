/**
 * Tiny self-contained Markdown renderer + code highlighter.
 * No CDN, no dependencies — the whole app must work offline / in a sandbox.
 */
(function (global) {
  'use strict';

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // ------------------------------------------------------------ highlight --

  const KEYWORDS =
    'abstract|as|async|await|base|bool|break|by|byte|case|catch|char|class|const|continue|debugger|def|default|del|delete|do|double|elif|else|end|enum|eval|except|export|extends|extern|False|final|finally|float|fn|for|from|func|function|global|go|goto|if|impl|implements|import|in|instanceof|int|interface|is|lambda|let|loop|match|module|mut|namespace|new|nil|None|not|null|or|package|pass|print|private|protected|public|pub|raise|readonly|record|ref|require|return|select|self|short|sizeof|static|str|struct|super|switch|synchronized|template|this|throw|throws|trait|True|try|type|typedef|typeof|union|unsafe|until|use|using|var|void|volatile|when|where|while|with|yield|and|elseif|foreach|echo|fi|then|esac|do|done|local';

  function highlight(code, lang) {
    const tokens = [];
    const stash = (cls, text) => {
      tokens.push(`<span class="tok-${cls}">${esc(text)}</span>`);
      return `\u0000${tokens.length - 1}\u0000`;
    };

    let src = code;

    // Placeholders are \u0000<index>\u0000 — digits. The number rule below must
    // therefore refuse to match digits that sit against a \u0000, otherwise it
    // rewrites the placeholder index and the stashed token is lost forever.
    const NUM = /(?<![\u0000\w.])-?\d+(\.\d+)?([eE][+-]?\d+)?(?![\u0000\w])/g;

    if (lang === 'json') {
      src = src.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (m, colon) =>
        colon ? stash('key', m.slice(0, -colon.length)) + colon : stash('str', m)
      );
      src = src.replace(/\b(true|false|null)\b/g, (m) => stash('bool', m));
      src = src.replace(NUM, (m) => stash('num', m));
    } else {
      // comments first so keywords inside them are not re-tokenised
      src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => stash('com', m));
      src = src.replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + stash('com', m.slice(p.length)));
      src = src.replace(/(^|\n)\s*#[^\n]*/g, (m) => stash('com', m));
      src = src.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, (m) => stash('str', m));
      src = src.replace(/`(?:[^`\\]|\\.)*`/g, (m) => stash('str', m));
      src = src.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => stash('str', m));
      src = src.replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => stash('str', m));
      src = src.replace(NUM, (m) => stash('num', m));
      src = src.replace(new RegExp(`(?<![\\u0000\\w$.])(${KEYWORDS})(?![\\u0000\\w$])`, 'g'), (m) => stash('kw', m));
      src = src.replace(/(?<![\u0000\w$.])([A-Za-z_$][\w$]*)(?=\s*\()/g, (m) => stash('fn', m));
      src = src.replace(/(?<![\u0000\w$.])([A-Z][A-Za-z0-9_]*)(?![\u0000\w$])/g, (m) => stash('cls', m));
    }

    return esc(src).replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
  }

  // --------------------------------------------------------------- inline --

  function inline(text) {
    const codes = [];
    let out = String(text).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(`<code class="md-code">${esc(c)}</code>`);
      return `\u0001${codes.length - 1}\u0001`;
    });

    out = esc(out);

    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) =>
      /^(https?:|data:)/i.test(src)
        ? `<img class="md-img" src="${src}" alt="${alt}" loading="lazy">`
        : alt
    );
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, href) =>
      /^(https?:|mailto:|#|\/)/i.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : m
    );
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => {
      const trimmed = url.replace(/[.,;:!?]+$/, '');
      const tail = url.slice(trimmed.length);
      return `${pre}<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${trimmed}</a>${tail}`;
    });

    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return out.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[Number(i)]);
  }

  // ---------------------------------------------------------------- block --

  function render(markdown) {
    const src = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const html = [];
    let i = 0;

    const listStack = [];
    const closeLists = (toDepth = 0) => {
      while (listStack.length > toDepth) html.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (fence) {
        closeLists();
        const marker = fence[1][0];
        const lang = (fence[2] || '').toLowerCase();
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        const raw = buf.join('\n');
        html.push(
          `<div class="md-codeblock" data-lang="${esc(lang || 'text')}">` +
            `<div class="md-codebar"><span class="md-lang">${esc(lang || 'text')}</span>` +
            `<button class="md-copy" type="button" data-code="${encodeURIComponent(raw)}">Copy</button></div>` +
            `<pre><code>${highlight(raw, lang)}</code></pre></div>`
        );
        continue;
      }

      // table
      if (
        /\|/.test(line) &&
        i + 1 < lines.length &&
        /^\s*\|?[\s:*-]*-[\s|:-]*\|?\s*$/.test(lines[i + 1]) &&
        lines[i + 1].includes('-')
      ) {
        closeLists();
        const splitRow = (r) =>
          r
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim());
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'
        );
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        html.push('<div class="md-tablewrap"><table><thead><tr>');
        head.forEach((c, n) =>
          html.push(`<th style="text-align:${align[n] || 'left'}">${inline(c)}</th>`)
        );
        html.push('</tr></thead><tbody>');
        rows.forEach((r) => {
          html.push('<tr>');
          head.forEach((_, n) =>
            html.push(`<td style="text-align:${align[n] || 'left'}">${inline(r[n] || '')}</td>`)
          );
          html.push('</tr>');
        });
        html.push('</tbody></table></div>');
        continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeLists();
        html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }

      // hr
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        closeLists();
        html.push('<hr>');
        i++;
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        closeLists();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        html.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // list item
      const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2) + 1;
        const kind = /^\d/.test(li[2]) ? 'ol' : 'ul';
        while (listStack.length > depth) html.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
        if (listStack.length < depth) {
          while (listStack.length < depth) {
            listStack.push(kind);
            html.push(kind === 'ol' ? '<ol>' : '<ul>');
          }
        } else if (listStack[listStack.length - 1] !== kind) {
          html.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
          listStack.push(kind);
          html.push(kind === 'ol' ? '<ol>' : '<ul>');
        }
        let content = li[3];
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          content = `<input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${task[2]}`;
          html.push(`<li class="md-task">${inline(content).replace(/&lt;input/g, '<input').replace(/disabled\s*(checked)?&gt;/g, (m) => m.replace('&gt;', '>'))}</li>`);
        } else {
          html.push(`<li>${inline(content)}</li>`);
        }
        i++;
        continue;
      }

      // blank
      if (!line.trim()) {
        closeLists();
        i++;
        continue;
      }

      // paragraph
      closeLists();
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(`{3,}|~{3,})/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      html.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }

    closeLists();
    return html.join('\n');
  }

  global.MD = { render, highlight, escapeHtml: esc };
})(window);
