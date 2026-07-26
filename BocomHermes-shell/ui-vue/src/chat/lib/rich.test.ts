// 契约测试 · 富结果引擎(rich.ts) ↔ card-ui-selftest 用例11 + 用例2 的转义信任边界
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../rich'

describe('renderMarkdown ↔ 用例11', () => {
  it('URL 渲染成 extlink(不含结尾中文逗号)', () => {
    const html = renderMarkdown('详见 https://wiki.bank.com/page?id=3，以及 src/mail.js:42 的实现')
    expect(html).toMatch(/<a class="extlink" data-url="https:\/\/wiki\.bank\.com\/page\?id=3"/)
  })
  it('文件:行 仍是 floc 链接', () => {
    const html = renderMarkdown('详见 https://wiki.bank.com/page?id=3，以及 src/mail.js:42 的实现')
    expect(html).toMatch(/<a class="floc" data-file="src\/mail\.js" data-line="42"/)
  })
  it('围栏代码块自带复制按钮(存量能力,防退化)', () => {
    expect(renderMarkdown('```js\nconst a=1\n```')).toMatch(/data-act="copy"/)
  })
})

describe('renderMarkdown · 转义信任边界(用例2 语义)', () => {
  it('正文里的 HTML 一律转义(脚本注不进来)', () => {
    const html = renderMarkdown('<script>alert(1)</script> 与 <img src=x onerror=pwn>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img')
  })
  it('行内代码/粗体/斜体正常渲', () => {
    const html = renderMarkdown('用 `monthly()` 的 **30/360** 口径')
    expect(html).toContain('<code>monthly()</code>')
    expect(html).toContain('<strong>30/360</strong>')
  })
  it('表格 / 列表 / 标题 / 引用 基础结构在', () => {
    const html = renderMarkdown('# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- 甲\n- 乙\n\n> 引一句')
    expect(html).toContain('<h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<ul><li>甲</li><li>乙</li></ul>')
    expect(html).toContain('<blockquote>')
  })
  it('连发分隔线去重(模型收尾段爱刷一排 ---,只留一条)', () => {
    const html = renderMarkdown('过程:\n\n---\n\n---\n\n---\n\n---\n\n完。')
    expect(html.match(/<hr>/g) || []).toHaveLength(1)
    expect(html).toContain('完。')
  })
})
