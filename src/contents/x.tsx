import cssText from "data-text:~style.css"
import type { PlasmoCSConfig } from "plasmo"
import { createRoot } from "react-dom/client"
import { DistributePanel } from "~components/DistributePanel"
import { bus } from "~utils/bus"

export const config: PlasmoCSConfig = {
  matches: ["https://x.com/*", "https://twitter.com/*"],
  run_at: "document_idle"
}

const BUTTON_FLAG = "data-x-dist-btn"
// lucide send（纸飞机）图标
const SEND_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18.75" height="18.75" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>'

const GRAY = "rgb(113, 118, 123)"
const BLUE = "rgb(29, 155, 240)"

// 分发按钮：紧凑 trailing 按钮——不参与操作栏等宽拉伸，紧跟在分享图标旁
function createDistributeButton(): HTMLElement {
  const wrap = document.createElement("div")
  Object.assign(wrap.style, {
    display: "flex",
    flex: "0 1 auto",
    alignItems: "center",
    minWidth: "0"
  } as CSSStyleDeclaration)
  wrap.setAttribute(BUTTON_FLAG, "1")
  const btn = document.createElement("button")
  btn.type = "button"
  btn.setAttribute("aria-label", "分发到抖音/小红书/即刻/微博/视频号")
  btn.title = "分发到抖音 / 小红书 / 即刻 / 微博 / 视频号"
  btn.innerHTML = SEND_SVG
  // 用 CSSOM 直接赋样式（不经过 <style> 标签，不受页面 CSP 影响）
  Object.assign(btn.style, {
    appearance: "none",
    background: "transparent",
    border: "none",
    margin: "0",
    padding: "0 7px",
    height: "34px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: GRAY,
    cursor: "pointer",
    borderRadius: "9999px",
    transition: "color 0.2s, background-color 0.2s"
  })
  btn.addEventListener("mouseenter", () => {
    btn.style.color = BLUE
    btn.style.backgroundColor = "rgba(29, 155, 240, 0.1)"
  })
  btn.addEventListener("mouseleave", () => {
    btn.style.color = GRAY
    btn.style.backgroundColor = "transparent"
  })
  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    const article = btn.closest("article") as HTMLElement | null
    if (article) {
      bus.emit("open-panel", { article })
    }
  })
  wrap.appendChild(btn)
  return wrap
}

// 操作栏定位：x.com 在 2026-11 改版，操作栏按钮从
// `button[data-testid="reply"]` + `div[role="group"]` 换成了 `data-engagement-action`，
// 例如 <button data-engagement-action="share" data-slot="xds-menu-trigger">。
// 新版的分享按钮是操作栏里最后一个动作，直接用它所在的行容器作锚点；
// 同时保留旧版选择器兜底。
function findActionBar(article: HTMLElement): HTMLElement | null {
  // 用最后一个匹配：推文内若嵌了引用帖，其操作栏会比本体更早出现
  const lastOf = <T extends Element>(selector: string): T | null => {
    const list = article.querySelectorAll<T>(selector)
    return list.length > 0 ? list[list.length - 1] : null
  }

  // 新版：以分享按钮为锚点，它的直接父节点就是尾部动作组（收藏 + 分享）
  const share = lastOf<HTMLElement>('[data-engagement-action="share"]')
  const newBar = share?.parentElement
  if (newBar && newBar !== article && article.contains(newBar)) return newBar

  // 新版兜底：任何带 data-engagement-action 的容器
  const anyAction = lastOf<HTMLElement>("[data-engagement-action]")
  const actionBar = anyAction?.parentElement
  if (actionBar && actionBar !== article && article.contains(actionBar)) return actionBar

  // 旧版：以回复按钮为锚点定位其所在 role=group
  const replyBtn = lastOf<HTMLElement>('button[data-testid="reply"]')
  const group = replyBtn?.closest('div[role="group"]') as HTMLElement | null
  if (group) return group
  const groups = article.querySelectorAll<HTMLElement>('div[role="group"]')
  return groups.length > 0 ? groups[groups.length - 1] : null
}

// 推文容器同样做过改版，逐个补齐候选
function findArticles(): HTMLElement[] {
  const set = new Set<HTMLElement>()
  for (const selector of ['article[data-testid="tweet"]', 'article[role="article"]', "article"]) {
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => set.add(el))
  }
  return Array.from(set)
}

let lastScanLog = 0
let firstInjectLogged = false
function scanAndInject() {
  const articles = findArticles()
  let injected = 0
  let matched = 0
  for (const article of articles) {
    const bar = findActionBar(article)
    if (!bar) continue
    matched++
    if (bar.querySelector(`[${BUTTON_FLAG}]`)) continue
    bar.appendChild(createDistributeButton())
    injected++
  }
  // 一条都没命中时打个节流日志，方便下次平台改版时快速定位
  if (articles.length > 0 && matched === 0 && Date.now() - lastScanLog > 10000) {
    lastScanLog = Date.now()
    console.warn(
      "[X分发] 未找到推文操作栏，页面结构可能又改版了：",
      `article=${articles.length}，` +
        `data-engagement-action=${document.querySelectorAll("[data-engagement-action]").length}，` +
        `role=group=${document.querySelectorAll('div[role="group"]').length}`
    )
  }
  // 只打一次，避免虚拟列表滚动时刷屏
  if (injected > 0 && !firstInjectLogged) {
    firstInjectLogged = true
    console.log(`[X分发] 分发图标注入正常（本轮 ${injected} 个）`)
  }
}

// 悬浮窗挂载到 shadow DOM，样式与 x.com 页面完全隔离
function mountPanel() {
  if (document.getElementById("x-dist-panel-host")) return
  const host = document.createElement("div")
  host.id = "x-dist-panel-host"
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = cssText
  shadow.appendChild(style)
  const container = document.createElement("div")
  shadow.appendChild(container)
  createRoot(container).render(<DistributePanel />)
}

let scanTimer: ReturnType<typeof setTimeout> | undefined

function init() {
  mountPanel()
  scanAndInject()

  // x.com 时间线是虚拟列表，节点会被回收重建，需持续补挂图标
  const observer = new MutationObserver(() => {
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(scanAndInject, 300)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

init()

// Plasmo 会用 CSUI（Content Script UI）模板包装所有 .tsx 内容脚本，
// 并渲染其 default export。本模块通过上面的 init() 副作用自行管理
// DOM（注入按钮 + shadow DOM 面板），不需要 CSUI 渲染任何界面。
// 但 CSUI 仍会执行 <RawMount.default />，若没有 default export 则为
// undefined，触发 React #130（Element type is invalid）。
// 因此提供一个返回 null 的空组件满足 CSUI 契约，避免报错。
export default function CSUINoop() {
  return null
}
