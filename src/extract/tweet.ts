// 从 x.com 页面 DOM 中提取推文内容（文本 / 图片 / 视频检测 / 推文 ID）
import type { FileData } from "~sync/common"

export interface TweetMediaItem {
  kind: "image" | "video"
  url: string // 发布用地址（原图 / mp4 / 卡片 dataUrl，发布前会在扩展页 blob 化）
  thumbUrl: string // 预览缩略图地址
  name: string
  type: string // mime
  label?: string // 媒体缩略图上的角标（如「卡片」）
}

export interface TweetStats {
  replies: string
  retweets: string
  likes: string
  bookmarks: string
  views: string
}

export interface ExtractedTweet {
  tweetId: string | null
  text: string
  media: TweetMediaItem[] // DOM 能拿到的图片（视频地址需经 syndication 接口解析）
  hasVideo: boolean
  videoPoster: string | null // video 元素的 poster，视频解析失败时降级用
  // 作者信息（分享卡片用）
  authorName: string
  authorHandle: string // 含 @ 前缀
  avatarUrl: string | null
  verified: boolean // 是否有认证徽章
  dateText: string // 如「2026年9月17日」
  stats: TweetStats // 互动数据（格式化后的字符串，可能为空）
  tweetUrl: string | null
}

// pbs.twimg.com 图片 URL 支持 name 参数控制尺寸（small/medium/large/orig）
export function withImageSize(url: string, name: string): string {
  try {
    const u = new URL(url)
    if (u.searchParams.has("name")) {
      u.searchParams.set("name", name)
      return u.toString()
    }
    return url
  } catch {
    return url
  }
}

function imageFileData(url: string): TweetMediaItem {
  let name = "image.jpg"
  let type = "image/jpeg"
  try {
    const u = new URL(url)
    const id = u.pathname.split("/").pop() || "image"
    const format = u.searchParams.get("format")
    const ext = format || id.split(".").pop() || "jpg"
    name = `${id.includes(".") ? id.split(".")[0] : id}.${ext}`
    type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg"
  } catch {
    // ignore
  }
  return {
    kind: "image",
    url: withImageSize(url, "orig"),
    thumbUrl: withImageSize(url, "small"),
    name,
    type
  }
}

// 引用帖容器：x.com 新旧两套标记都要排除，避免把引用内容当成本体
const QUOTE_SELECTORS = '[data-testid="quoteTweet"], [data-testid="quotedTweet"]'

// 正文：老版用 div[data-testid="tweetText"]，2026-11 改版后去掉 testid，
// 改为带 lang 属性的文本块，这里做双兼容
function extractText(article: HTMLElement): string {
  const join = (nodes: HTMLElement[]) =>
    nodes
      .map((n) => (n.innerText || "").trim())
      .filter(Boolean)
      .join("\n\n")

  const legacy = Array.from(article.querySelectorAll<HTMLElement>('div[data-testid="tweetText"]'))
  if (legacy.length > 0) return join(legacy)

  const blocks = Array.from(article.querySelectorAll<HTMLElement>("div[lang], span[lang]")).filter(
    (el) => !el.closest(QUOTE_SELECTORS)
  )
  // 只取最外层，避免父子节点文本重复
  const outer = blocks.filter((el) => !blocks.some((other) => other !== el && other.contains(el)))
  return join(outer)
}

// 图片：老版取 tweetPhoto 内的 img；新版没有该 testid，退回图床地址匹配
function extractImages(article: HTMLElement): TweetMediaItem[] {
  const legacy = Array.from(article.querySelectorAll<HTMLImageElement>('div[data-testid="tweetPhoto"] img'))
  const imgs =
    legacy.length > 0
      ? legacy
      : Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]')).filter(
          (img) => !img.closest(QUOTE_SELECTORS)
        )

  const seen = new Set<string>()
  const media: TweetMediaItem[] = []
  for (const img of imgs) {
    const src = img.currentSrc || img.src
    if (!src || !src.includes("pbs.twimg.com")) continue
    const origUrl = withImageSize(src, "orig")
    if (seen.has(origUrl)) continue
    seen.add(origUrl)
    media.push(imageFileData(src))
  }
  return media
}

// 从 article DOM 解析推文自身（非引用推文）的 status id
function extractTweetId(article: HTMLElement): string | null {
  const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'))
  const pattern = /^\/[^/]+\/status\/(\d+)/
  // 优先取引用推文区域之外的链接（推文自身的时间戳链接）
  const outer = anchors.filter((a) => !a.closest(QUOTE_SELECTORS))
  for (const a of [...outer, ...anchors]) {
    const m = a.getAttribute("href")?.match(pattern)
    if (m) return m[1]
  }
  return null
}

// 从 article DOM 解析作者显示名 / @handle（用于分享卡片）
function extractAuthor(article: HTMLElement): { authorName: string; authorHandle: string } {
  const userNameEl = article.querySelector('div[data-testid="User-Name"]')

  if (userNameEl) {
    const anchors = Array.from(userNameEl.querySelectorAll<HTMLAnchorElement>("a"))
    let authorHandle = ""
    for (const a of anchors) {
      const text = (a.innerText || "").trim()
      if (text.startsWith("@") && !authorHandle) {
        authorHandle = text
        break
      }
    }
    const nameAnchor = anchors.find((a) => {
      const href = a.getAttribute("href") || ""
      const text = (a.innerText || "").trim()
      return /^\/[^/]+$/.test(href) && text !== "" && !text.startsWith("@")
    })
    const authorName = nameAnchor ? nameAnchor.innerText.trim() : ""
    return { authorName, authorHandle }
  }

  // 新版兜底：从头部用户名链接里解析
  const links = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')).filter(
    (a) => !a.closest(QUOTE_SELECTORS)
  )
  let authorHandle = ""
  for (const a of links) {
    const text = (a.innerText || "").trim()
    if (/^@[A-Za-z0-9_]{1,15}$/.test(text)) {
      authorHandle = text
      break
    }
  }
  const nameAnchor = links.find((a) => {
    const href = a.getAttribute("href") || ""
    const text = (a.innerText || "").trim()
    return /^\/[A-Za-z0-9_]{1,15}$/.test(href) && text !== "" && !text.startsWith("@")
  })
  return { authorName: nameAnchor ? nameAnchor.innerText.trim() : "", authorHandle }
}

// 从操作栏按钮提取格式化的互动数。
// 老版用 button[data-testid="like"]，新版用 data-engagement-action="like"
function buttonCount(article: HTMLElement, testid: string, action: string): string {
  const btn =
    article.querySelector(`button[data-testid="${testid}"]`) ??
    article.querySelector(`[data-engagement-action="${action}"]`)
  if (!btn) return ""
  const span = btn.querySelector("span")
  const text = span?.innerText?.trim()
  if (text) return text
  // 回复数为 0 时按钮里没有 span，退回 aria-label（如「25 replies. Reply」/「39 次加入书签。加入书签」）
  const label = btn.getAttribute("aria-label") ?? ""
  const m = label.match(/\d[\d.,]*\s*[KMB]?/i)
  return m ? m[0].trim() : ""
}

// 浏览数：老版在 analytics 链接里；新版去掉了链接，退回正文文本匹配
function extractViews(article: HTMLElement): string {
  const link = article.querySelector<HTMLAnchorElement>('a[href$="/analytics"]')
  if (link) return (link.innerText || "").replace(/views?|次浏览|次查看/gi, "").trim()
  const m = (article.innerText || "").match(/([\d.,]+\s*(?:[KMB]|万|亿)?)\s*次?\s*(?:浏览|查看|views?)/i)
  return m ? m[1].trim() : ""
}

export function extractTweet(article: HTMLElement): ExtractedTweet {
  const text = extractText(article)
  const media = extractImages(article)

  // 视频检测：article 内存在 video 元素（src 是 blob，真实地址需走 syndication 接口）
  const videoEl = article.querySelector("video")
  const hasVideo = videoEl !== null
  const videoPoster =
    videoEl && videoEl.poster && videoEl.poster.includes("pbs.twimg.com") ? videoEl.poster : null

  const tweetId = extractTweetId(article)

  // 作者信息（分享卡片用）
  const { authorName, authorHandle } = extractAuthor(article)
  const avatarEl =
    article.querySelector<HTMLImageElement>('div[data-testid="Tweet-User-Avatar"] img') ??
    article.querySelector<HTMLImageElement>('img[src*="profile_images"]')
  const avatarUrl = avatarEl?.src || null
  // 认证徽章：老版是 icon-verified，新版是一个 aria-label="认证账号" 的元素
  const verified = Boolean(
    article.querySelector('[data-testid="icon-verified"], [aria-label*="认证"], [aria-label*="Verified"]')
  )
  const datetime = article.querySelector("time")?.getAttribute("datetime")
  const dateText = datetime
    ? new Date(datetime).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    : ""
  const stats: TweetStats = {
    replies: buttonCount(article, "reply", "reply"),
    retweets: buttonCount(article, "retweet", "retweet"),
    likes: buttonCount(article, "like", "like"),
    bookmarks: buttonCount(article, "bookmark", "bookmark"),
    views: extractViews(article)
  }
  const tweetUrl =
    tweetId && authorHandle
      ? `https://x.com/${authorHandle.replace(/^@/, "")}/status/${tweetId}`
      : null

  return {
    tweetId,
    text,
    media,
    hasVideo,
    videoPoster,
    authorName,
    authorHandle,
    avatarUrl,
    verified,
    dateText,
    stats,
    tweetUrl
  }
}

// syndication 接口返回的媒体信息（由 background 代抓，见 src/background/syndication.ts）
export interface SyndicationMedia {
  type: "photo" | "video" | "animated_gif"
  media_url_https: string
  video_info?: {
    variants: { bitrate?: number; content_type: string; url: string }[]
  }
}

export interface TweetMediaResult {
  ok: boolean
  error?: string
  images: TweetMediaItem[]
  video: TweetMediaItem | null
  videoPoster: string | null
}

// 将 syndication mediaDetails 转为面板媒体项（在 background 与内容脚本中均可调用）
export function syndicationToMedia(details: SyndicationMedia[]): Omit<TweetMediaResult, "ok" | "error"> {
  const images: TweetMediaItem[] = []
  let video: TweetMediaItem | null = null
  let videoPoster: string | null = null

  for (const detail of details ?? []) {
    if (detail.type === "photo") {
      const item = imageFileData(detail.media_url_https)
      images.push(item)
    } else {
      // video / animated_gif：取码率最高的 mp4 变体
      const variants = detail.video_info?.variants ?? []
      const mp4s = variants.filter((v) => v.content_type === "video/mp4" && v.url)
      const best = mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]
      if (best) {
        video = {
          kind: "video",
          url: best.url,
          thumbUrl: detail.media_url_https,
          name: `video-${detail.media_url_https.split("/").pop()?.split("?")[0] || "video"}.mp4`,
          type: "video/mp4"
        }
      }
      videoPoster = detail.media_url_https || null
    }
  }

  return { images, video, videoPoster }
}
