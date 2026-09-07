import type { JSX as ReactJSX } from 'react'

/**
 * A deliberately small Markdown renderer that builds React elements and never
 * touches innerHTML, so nothing in an artifact can execute or inject markup.
 * Link targets are shown as text rather than becoming anchors: a run artifact
 * is evidence to read, not a place to click through from.
 */
function renderInline(text: string, keyPrefix: string): ReactJSX.Element[] {
  const nodes: ReactJSX.Element[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-t${index++}`}>{text.slice(lastIndex, match.index)}</span>)
    }
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-c${index++}`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-b${index++}`}>{token.slice(2, -2)}</strong>)
    } else {
      nodes.push(<em key={`${keyPrefix}-i${index++}`}>{token.slice(1, -1)}</em>)
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) {
    nodes.push(<span key={`${keyPrefix}-t${index++}`}>{text.slice(lastIndex)}</span>)
  }
  return nodes
}

export function Markdown({ source }: { source: string }): JSX.Element {
  const blocks: JSX.Element[] = []
  const lines = source.split('\n')
  let list: string[] = []
  const fence: { lines: string[] | null } = { lines: null }

  const flushList = (key: string): void => {
    if (list.length === 0) return
    blocks.push(
      <ul key={key}>
        {list.map((item, index) => (
          <li key={`${key}-${index}`}>{renderInline(item, `${key}-${index}`)}</li>
        ))}
      </ul>,
    )
    list = []
  }

  lines.forEach((line, index) => {
    const key = `b${index}`
    if (line.trimStart().startsWith('```')) {
      if (fence.lines === null) {
        flushList(`${key}-l`)
        fence.lines = []
      } else {
        blocks.push(<pre key={key}>{fence.lines.join('\n')}</pre>)
        fence.lines = null
      }
      return
    }
    if (fence.lines !== null) {
      fence.lines.push(line)
      return
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushList(`${key}-l`)
      const level = Math.min(heading[1]?.length ?? 1, 3)
      const text = heading[2] ?? ''
      if (level === 1) blocks.push(<h1 key={key}>{renderInline(text, key)}</h1>)
      else if (level === 2) blocks.push(<h2 key={key}>{renderInline(text, key)}</h2>)
      else blocks.push(<h3 key={key}>{renderInline(text, key)}</h3>)
      return
    }
    // A thematic break. Every artifact this console renders puts its metadata
    // above one, so leaving it as literal dashes reads like a mistake.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList(`${key}-l`)
      blocks.push(<hr key={key} />)
      return
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      list.push(bullet[1] ?? '')
      return
    }
    flushList(`${key}-l`)
    if (line.trim() === '') return
    blocks.push(<p key={key}>{renderInline(line, key)}</p>)
  })
  flushList('tail')
  if (fence.lines !== null) blocks.push(<pre key="tail-fence">{fence.lines.join('\n')}</pre>)

  return <div className="md">{blocks}</div>
}
