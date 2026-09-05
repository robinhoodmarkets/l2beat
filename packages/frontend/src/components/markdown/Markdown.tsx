import MarkdownIt from 'markdown-it'
import { useId } from 'react'
import { cn } from '~/utils/cn'
import {
  glossaryPlugin,
  linkGlossaryTerms,
} from '~/utils/markdown/glossaryPlugin'
import { outLinksPlugin } from '~/utils/markdown/outlinksPlugin'
import { useGlossaryContext } from './GlossaryContext'
import { GlossaryTooltipWrapper } from './GlossaryTooltipWrapper'

interface MarkdownProps {
  children: string
  inline?: boolean
  className?: string
  ignoreGlossary?: boolean
}

const markdown = MarkdownIt({
  html: true,
  typographer: true,
})
  .use(outLinksPlugin)
  .use(glossaryPlugin)

// [SECURITY PATCH]: Link handling hardened for externally supplied markdown
// Enforces target="_blank" and rel="noopener noreferrer" on all external links
// to prevent reverse tabnabbing and restricts dangerous URI schemes.
const defaultRender =
  markdown.renderer.rules.link_open ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options)
  }

markdown.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const hrefIndex = tokens[idx].attrIndex('href')
  if (hrefIndex >= 0 && tokens[idx].attrs) {
    const href = tokens[idx].attrs![hrefIndex][1]
    // Defang potentially dangerous protocols (e.g. XSS via javascript: URIs)
    if (/^(javascript|vbscript|data):/i.test(href.trim())) {
      tokens[idx].attrs![hrefIndex][1] = '#'
    }
  }

  const targetIndex = tokens[idx].attrIndex('target')
  if (targetIndex < 0) {
    tokens[idx].attrPush(['target', '_blank'])
  } else if (tokens[idx].attrs) {
    tokens[idx].attrs[targetIndex][1] = '_blank'
  }

  const relIndex = tokens[idx].attrIndex('rel')
  if (relIndex < 0) {
    tokens[idx].attrPush(['rel', 'noopener noreferrer'])
  } else if (tokens[idx].attrs) {
    tokens[idx].attrs[relIndex][1] = 'noopener noreferrer'
  }

  return defaultRender(tokens, idx, options, env, self)
}

export function Markdown(props: MarkdownProps) {
  const terms = useGlossaryContext()
  // One useId() per component instance, called unconditionally at the top level.
  // processCollapsibleText used to call useId() from inside its String.replace
  // callback, so the number of hooks this component consumed depended on how many
  // `[label: content]` matches its markdown happened to contain. React matches
  // hooks positionally across renders, so re-rendering the same Markdown instance
  // with a different number of matches throws "Rendered more hooks than during the
  // previous render". The per-match suffix added below keeps the generated ids
  // unique both within an instance and between instances.
  const baseId = useId()
  const Comp = props.inline ? 'span' : 'div'
  const render = (text: string) =>
    props.inline ? markdown.renderInline(text) : markdown.render(text)

  // Markdown-it does not support pre-render hooks and token rerendering so
  // we have to the do linking of glossary terms here explicitly.
  const rendered = render(
    props.ignoreGlossary
      ? props.children
      : linkGlossaryTerms(terms)(props.children),
  )
  const collapsed = processCollapsibleText(rendered, baseId)

  return (
    <GlossaryTooltipWrapper>
      <Comp
        className={cn('mdc', props.className)}
        dangerouslySetInnerHTML={{ __html: collapsed }}
      />
    </GlossaryTooltipWrapper>
  )
}

/**
 * Processes custom markdown syntax for collapsible text using HTML with Tailwind CSS
 * Format: [label: hidden content]
 * Uses the native <details> and <summary> elements with Tailwind classes
 *
 * `baseId` comes from a single useId() in the calling component: this function runs
 * during render but is not itself a component or a hook, so it must not call hooks.
 */
function processCollapsibleText(markdown: string, baseId: string): string {
  const collapsiblePattern = /\[([^:]+):\s*(.*?)\]/g
  let matchIndex = 0

  return markdown.replace(collapsiblePattern, (_match, label, content) => {
    const uniqueId = `${baseId}-collapsible-${matchIndex++}`
    return `<button class="inline text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded px-1 text-sm cursor-pointer select-none hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600" onclick="document.getElementById('${uniqueId}').classList.toggle('hidden')">${label}</button><span id="${uniqueId}" class="hidden ml-1">${content}</span>`
  })
}