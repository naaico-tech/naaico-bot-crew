// A small, safe Markdown renderer for chat: no dependencies, everything escaped first, so
// the only HTML out is the tags below.
//   md(text) -> HTML string
// Supports: paragraphs, line breaks, # headings, - and 1. lists, > quotes, ``` code blocks,
// `code`, **bold**, *italic* / _italic_, ~~strike~~, [links](https://…), | tables |, ---,
// ![images](…) and video, bare links, and Claude Artifact links as cards.
// Links must be http(s) or mailto. Files on this Mac (/abs/path.mp4, ~/x.png, file://…)
// are shown through the runner's /api/file, which serves only images and video from the
// bots' working folders and the crew store.

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i
const VIDEO = /\.(mp4|webm|mov|m4v)$/i
const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/i
const URL_IN = /((?:[^()\s]|\([^()\s]*\))+)/.source

/** A URL a page may load media from: http(s) as is, local paths through the runner. */
function mediaSrc(url) {
  if (/^https?:\/\//i.test(url)) return url
  let path = url
  if (/^file:\/\//i.test(path)) {
    try { path = decodeURIComponent(path.slice(7)) } catch { return undefined }
  }
  if (/^(\/|~\/)/.test(path)) return '/api/file?path=' + encodeURIComponent(path)
  return undefined
}

function media(url, alt) {
  const path = url.split(/[?#]/)[0]
  const src = mediaSrc(url)
  if (!src) return undefined
  if (VIDEO.test(path)) return `<video class="md-media" controls preload="metadata" src="${esc(src)}" aria-label="${esc(alt || 'Video')}"></video>`
  if (IMAGE.test(path)) return `<a class="md-media-link" href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img class="md-media" src="${esc(src)}" alt="${esc(alt || '')}" loading="lazy"></a>`
  return undefined
}

function artifactCard(url, label) {
  const title = label && label !== url ? label : 'Claude artifact'
  return `<a class="md-artifact" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span class="md-artifact-kicker">Claude artifact</span><span class="md-artifact-title">${esc(title)}</span><span class="md-artifact-open">Open ↗</span></a>`
}

function link(url, text) {
  if (ARTIFACT.test(url)) return artifactCard(url, text)
  const m = media(url, text)
  if (m && (text === url || !/^https?:/i.test(url))) return m
  if (/^(https?:\/\/|mailto:)/i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`
  return esc(text)
}

function inline(raw) {
  // Code spans, media and links are rendered first and held aside, so their contents
  // are never escaped twice or formatted.
  const held = []
  const hold = html => `\u0000${held.push(html) - 1}\u0000`
  let s = raw.replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`))
  s = s.replace(new RegExp(`!\\[([^\\]\\n]*)\\]\\(${URL_IN}\\)`, 'g'), (m, alt, url) => hold(media(url, alt) ?? esc(alt || url)))
  s = s.replace(new RegExp(`\\[([^\\]\\n]+)\\]\\(${URL_IN}\\)`, 'g'), (m, text, url) => hold(link(url, text)))
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g, (m, pre, url) => pre + hold(link(url, url)))
  s = s.replace(/(^|\s)((?:~|\/)[^\s<>"'`]+\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|m4v))(?=$|[\s.,;:!?)])/gi, (m, pre, path) => pre + hold(media(path, '') ?? esc(path)))
  s = esc(s)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i])
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
