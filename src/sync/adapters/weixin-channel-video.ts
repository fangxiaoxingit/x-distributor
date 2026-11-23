import type { SyncData, VideoData } from "../common"

// 微信视频号（视频号助手网页版）视频发布适配器
// 页面：https://channels.weixin.qq.com/platform/post/create（「发表动态」）
//
// 只做三件事：上传视频 → 填短标题 → 填视频描述。
// 位置、合集、链接、活动、定时发表、原创声明、「发表」按钮一律不碰，
// 由用户自己在页面上核对后手动完成。
//
// 关键点：视频号助手是 wujie 微前端 + Module Federation 架构，真正的 DOM 可能挂在
// shadow root 或同源 iframe 里，`document.querySelector` 穿不透，必须递归深入查询。
// 因此这里所有查询都走 deepQuery/deepQueryAll，事件也都带 composed: true。
export async function VideoWeixinChannel(data: SyncData) {
  const { title, content, video, tags } = data.data as VideoData
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const tag = "[X分发] 视频号："
  console.log(tag, "适配器已启动", location.href)

  // ---------- 穿透 shadow root / 同源 iframe 的查询 ----------
  function collectRoots(): (Document | ShadowRoot)[] {
    const roots: (Document | ShadowRoot)[] = []
    const seen = new Set<Document | ShadowRoot>()
    const walk = (root: Document | ShadowRoot) => {
      if (seen.has(root)) return
      seen.add(root)
      roots.push(root)
      let all: Element[] = []
      try {
        all = Array.from(root.querySelectorAll("*"))
      } catch {
        return
      }
      for (const el of all) {
        const shadow = (el as HTMLElement).shadowRoot
        if (shadow) walk(shadow)
        if (el.tagName === "IFRAME") {
          try {
            const doc = (el as HTMLIFrameElement).contentDocument
            if (doc) walk(doc)
          } catch {
            // 跨域 iframe 不可访问，跳过
          }
        }
      }
    }
    walk(document)
    return roots
  }

  function deepQueryAll<T extends Element = Element>(selector: string): T[] {
    const out: T[] = []
    for (const root of collectRoots()) {
      try {
        for (const el of Array.from(root.querySelectorAll<T>(selector))) {
          if (!out.includes(el)) out.push(el)
        }
      } catch {
        // 忽略非法选择器
      }
    }
    return out
  }

  function deepQuery<T extends Element = Element>(selector: string): T | null {
    return deepQueryAll<T>(selector)[0] ?? null
  }

  // 按选择器优先级逐个查询（querySelectorAll 的选择器列表是文档顺序，不保证优先级）
  function deepQueryFirstOf<T extends Element = Element>(selectors: string[]): T | null {
    for (const selector of selectors) {
      const hit = deepQuery<T>(selector)
      if (hit) return hit
    }
    return null
  }

  async function waitForDeep<T extends Element = Element>(selector: string, timeout = 20000): Promise<T | null> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = deepQuery<T>(selector)
      if (found) return found
      await sleep(400)
    }
    return null
  }

  async function waitForDeepFirstOf<T extends Element = Element>(
    selectors: string[],
    timeout = 20000
  ): Promise<T | null> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const found = deepQueryFirstOf<T>(selectors)
      if (found) return found
      await sleep(400)
    }
    return null
  }

  // ---------- 工具 ----------
  function makeTransfer(file: File): DataTransfer {
    const transfer = new DataTransfer()
    transfer.items.add(file)
    return transfer
  }

  function isVisible(el: Element): boolean {
    return el.getClientRects().length > 0
  }

  // 上传是否真的开始：左侧出现了视频预览/上传列表项，或出现进度类文案。
  // 注意：上传前左侧只有虚线框和加号，既没有 <video> 也没有上传列表项，
  // 所以「存在」本身就是足够强的信号，不必再判断可见性。
  function hasUploadSignal(): boolean {
    const wrap = deepQuery(".post-upload-wrap")
    if (wrap) {
      if (wrap.querySelector("video, .ant-upload-list-item, img")) return true
      if (/上传中|处理中|转码中|上传成功|处理完成|\d{1,3}%/.test(wrap.textContent || "")) return true
    }
    const anyVideo = deepQueryAll("video").some(isVisible)
    if (anyVideo) return true
    return deepQueryAll(".ant-upload-list-item").length > 0
  }

  // ---------- 上传视频 ----------
  async function uploadVideo(file: File): Promise<boolean> {
    // Ant Design Upload 内部一定有隐藏的 input[type=file]，优先直接注入
    const input = await waitForDeepFirstOf<HTMLInputElement>(
      [
        ".post-upload-wrap input[type='file']",
        ".ant-upload input[type='file']",
        "input[type='file'][accept*='video']",
        "input[type='file']"
      ],
      15000
    )

    if (input) {
      try {
        const transfer = makeTransfer(file)
        const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set
        if (filesSetter) filesSetter.call(input, transfer.files)
        else input.files = transfer.files
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
        console.log(tag, "已注入视频到 file input", file.name, `${(file.size / 1024 / 1024).toFixed(1)}MB`)
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          if (hasUploadSignal()) return true
          await sleep(600)
        }
        console.warn(tag, "注入文件后 15 秒内未见上传信号，尝试拖放兜底")
      } catch (error) {
        console.warn(tag, "注入 file input 失败:", error)
      }
    }

    // 兜底：对拖拽区派发完整 drag 事件
    const dropZone =
      deepQuery(".post-upload-wrap .ant-upload.ant-upload-drag") ?? deepQuery(".ant-upload.ant-upload-drag")
    if (dropZone && typeof DragEvent !== "undefined") {
      try {
        const transfer = makeTransfer(file)
        for (const type of ["dragenter", "dragover", "drop"]) {
          dropZone.dispatchEvent(
            new DragEvent(type, { bubbles: true, composed: true, cancelable: true, dataTransfer: transfer })
          )
        }
        console.log(tag, "已向拖拽区派发 drop", file.name)
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          if (hasUploadSignal()) return true
          await sleep(600)
        }
        return false
      } catch (error) {
        console.warn(tag, "拖放上传失败:", error)
      }
    }

    if (!input) console.error(tag, "未找到文件输入框，请手动点击上传区选择视频")
    return false
  }

  // ---------- 填短标题（视频号要求 6-16 字，超长会被截断） ----------
  async function fillShortTitle(): Promise<boolean> {
    const input = await waitForDeep<HTMLInputElement>('input[placeholder*="短标题"]', 10000)
    if (!input) {
      console.warn(tag, "未找到短标题输入框")
      return false
    }
    const text = (title || content || "").replace(/\s+/g, " ").trim().slice(0, 16)
    if (!text) return false
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    input.focus()
    if (valueSetter) valueSetter.call(input, text)
    else input.value = text
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
    input.blur()
    await sleep(200)
    return true
  }

  // ---------- 填视频描述 ----------
  async function fillDescription(): Promise<boolean> {
    const suffix = tags?.length ? ` ${tags.map((t) => `#${t}`).join(" ")}` : ""
    const text = `${content || ""}${suffix}`.trim().slice(0, 1000)
    if (!text) return false

    const textarea = await waitForDeepFirstOf<HTMLTextAreaElement>(
      ['textarea[placeholder*="描述"]', "textarea"],
      10000
    )
    if (textarea) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      textarea.focus()
      if (valueSetter) valueSetter.call(textarea, text)
      else textarea.value = text
      textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
      textarea.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
      textarea.blur()
      await sleep(300)
      return true
    }

    // 兜底：富文本编辑器
    const richEditor = deepQuery<HTMLElement>('[contenteditable="true"]')
    if (richEditor) {
      richEditor.focus()
      richEditor.textContent = text
      richEditor.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
      richEditor.blur()
      await sleep(300)
      return true
    }

    console.warn(tag, "未找到视频描述输入框")
    return false
  }

  // ---------- 主流程 ----------
  try {
    if (!video) {
      console.error(tag, "没有视频文件，视频号只支持视频发布")
      return
    }

    const response = await fetch(video.url)
    if (!response.ok) throw new Error(`读取视频失败: HTTP ${response.status}`)
    const blob = await response.blob()
    const file = new File([blob], video.name, { type: video.type || blob.type || "video/mp4" })

    // 等上传区渲染出来（含 shadow DOM / iframe 场景）
    await waitForDeepFirstOf(
      [".post-upload-wrap", ".ant-upload.ant-upload-drag", "input[type='file']"],
      30000
    )

    const uploaded = await uploadVideo(file)
    const filledTitle = await fillShortTitle()
    const filledDesc = await fillDescription()

    console.log(
      tag,
      `完成 —— 上传=${uploaded ? "是" : "否"}，短标题=${filledTitle ? "是" : "否"}，描述=${filledDesc ? "是" : "否"}`
    )
    if (!uploaded) console.warn(tag, "未检测到上传信号，请手动确认左侧上传区状态")
  } catch (error) {
    console.error(tag, "出错:", error)
  }
}
