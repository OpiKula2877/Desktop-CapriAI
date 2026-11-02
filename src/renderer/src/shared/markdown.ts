import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const l = (lang ?? '').replace(/[^\w+#-]/g, '')
  return `<div class="code"><div class="code-head"><span>${l || 'shard'}</span><button class="code-copy" type="button">COPY</button></div><pre><code>${esc}</code></pre></div>`
}
renderer.link = ({ href, text }) => `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { renderer, async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}
