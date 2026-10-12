// A small, safe Markdown renderer for bot replies: no dependencies, everything escaped
// first, so the only HTML out is the tags below. Links must be http(s) or mailto.
//   md(text) -> HTML string
// Supports: paragraphs, line breaks, # headings, - and 1. lists, > quotes, ``` code blocks,
// `code`, **bold**, *italic* / _italic_, ~~strike~~, [links](https://…), | tables |, ---.

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function inline(raw) {
  // Code spans first, held aside so their contents are never formatted.
  const codes = []
  let s = raw.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = esc(s)
  s = s.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, text, url) => {
    const u = url.replace(/&amp;/g, '&')
    if (!/^(https?:\/\/|mailto:)/i.test(u)) return text
    return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`)
}

const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

export function md(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre class="md-code"><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { i++; continue }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = Math.min(6, h[1].length + 2)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(`<table class="md-table"><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${md(body.join('\n'))}</blockquote>`)
      continue
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+/)
    if (list) {
      const ordered = /\d/.test(list[1])
      const items = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; continue }
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map(it => `<li>${inline(it)}</li>`).join('')}</${tag}>`)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}
