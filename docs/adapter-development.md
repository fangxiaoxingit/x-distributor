# 新增分发平台适配器开发指南

本文记录编写 `src/sync/adapters/*.ts` 平台适配器时最容易踩的坑，以及验证方法。视频号（`weixin-channel-video.ts`）适配时踩到的微前端问题放在最前面，因为它最隐蔽——**脚本看起来跑了，实际什么都没做，控制台还没有任何报错**。

---

## 一、适配器的执行环境

适配器最终通过 `chrome.scripting.executeScript` 注入到目标页面执行：

```ts
await chrome.scripting.executeScript({
  target: { tabId },
  func: platformInfo.injectFunction,
  args: [data]
})
```

由此带来三条硬约束：

1. **必须自包含**。函数被序列化后注入，不能引用模块作用域的任何变量、import 进来的工具函数、闭包变量。所以下文所有工具函数都要**内联写在适配器函数体内部**，不能抽成公共模块 import 进来。
2. **运行在隔离世界（isolated world）**，共享 DOM，但不共享页面 JS 变量。
3. **返回值 / Promise 会被等待**。长流程（上传、等待转码）可以直接 `await`，但注意 MV3 service worker 可能被回收，流程尽量在前 5 分钟内结束。

---

## 二、头号坑：微前端 shadow DOM

### 现象

- 打开平台发布页，控制台**找不到任何适配器的日志**（或只有启动日志），页面毫无反应
- 手动在控制台执行 `document.querySelector('.post-upload-wrap')` 返回 `null`，但页面上明明有这个元素
- 控制台有这类特征日志：
  - `[wujie warn]: 此报错可以忽略，iframe主动中断主应用代码在子应用运行`
  - `content beforeUnmount 生命周期` / `content afterUnmount 生命周期`
  - `[ Federation Runtime ] ... shared singleton module ...`
  - `[qiankun] ...` / `single-spa ...`

### 原因

国内大厂创作者后台（视频号助手、部分公众号后台等）普遍用 **wujie / qiankun** 这类微前端框架。子应用的 DOM 并不直接挂在主文档上，而是挂在：

- `<wujie-app>` 自定义元素的 **shadowRoot** 里（wujie 默认模式），或
- 一个同源 `about:blank` iframe 的 `document` 里（polyfill 模式）

`document.querySelector` **不能穿透 shadow boundary**，也进不去 iframe，所以全部查询返回 `null`，适配器「找不到元素」就静默退出了。

### 判断方法

在目标页控制台执行：

```js
document.querySelector('.post-upload-wrap')            // null 但页面上有 → 大概率在 shadow root
document.querySelectorAll('wujie-app').length          // > 0 → wujie
document.querySelector('wujie-app')?.shadowRoot        // 有值 → DOM 在 shadowRoot 里
document.querySelectorAll('iframe').length             // 有同源 iframe 也要考虑
```

---

## 三、解决方案：递归深层查询

不要用 `document.querySelector`，改成先在「所有可查询的根」上找：

```ts
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
          if (doc) walk(doc) // 跨域 iframe 会抛错，跳过即可
        } catch {
          // cross-origin iframe，无解，只能让用户手动操作
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

// 按选择器优先级查找：querySelectorAll('.a, .b') 是按文档顺序返回，
// 不保证 .a 优先，所以优先级必须逐个 selector 查询
function deepQueryFirstOf<T extends Element = Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    const hit = deepQuery<T>(selector)
    if (hit) return hit
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
```

### 配套注意点

**1. 事件必须带 `composed: true`**

在 shadow root 内派发的事件默认不会跨出边界，页面的监听器收不到：

```ts
el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
el.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
dropZone.dispatchEvent(
  new DragEvent("drop", { bubbles: true, composed: true, cancelable: true, dataTransfer: transfer })
)
```

**2. 不要用 `MutationObserver` 等元素**

observer 只能监听你明确指定的 root，而微前端的 shadow root 是运行时才出现的，你还不知道它在哪。改成**轮询 + 深层查询**，简单且不会漏：

```ts
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  const el = deepQuery(".post-upload-wrap")
  if (el) break
  await sleep(400)
}
```

**3. 不要用 `getClientRects()` 判断「元素存在」**

对「上传前不存在、上传后出现」的节点（例如左侧的视频预览），**存在性本身就是足够强的信号**，不必再判断可见性。反过来，依赖 `getClientRects().length > 0` 会让 jsdom 测试永远为假，也不利于排查。

---

## 四、通用坑：React 受控组件

`input.value = x` 和模拟 `paste` 事件在 React 里通常无效，因为 React 自己维护了一份 value 跟踪。必须用原生 setter 绕过：

```ts
const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
el.focus()
if (valueSetter) valueSetter.call(el, text)
else el.value = text
el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
el.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
el.blur()
```

`textarea` 与 `input` 要分别取 `HTMLTextAreaElement.prototype` / `HTMLInputElement.prototype` 上的描述符。

---

## 五、通用坑：文件上传注入

Ant Design `Upload` / 大多数上传组件内部都有隐藏的 `input[type=file]`，直接给它塞 `File` 最可靠：

```ts
const transfer = new DataTransfer()
transfer.items.add(file)
const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set
if (filesSetter) filesSetter.call(input, transfer.files)
else input.files = transfer.files
input.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
input.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
```

失败兜底：往拖拽区派发完整 drag 序列（注意 `DragEvent` 在极少数环境不存在，加个守卫）：

```ts
if (dropZone && typeof DragEvent !== "undefined") {
  for (const type of ["dragenter", "dragover", "drop"]) {
    dropZone.dispatchEvent(
      new DragEvent(type, { bubbles: true, composed: true, cancelable: true, dataTransfer: transfer })
    )
  }
}
```

**不能**通过 `input.click()` 打开系统文件选择框——需要真实用户手势，且脚本无法代选文件。

---

## 六、调试与验证

### 1. 日志规范

适配器统一用 `console.log("[X分发] <平台>：...")` 前缀，并且**在函数最开头就打一条**：

```ts
console.log(tag, "适配器已启动", location.href)
```

这条日志的价值极高：能一眼区分「脚本没注入」和「注入了但没找到元素」这两类完全不同的故障。

结尾再打一条汇总，方便定位是哪一步没成：

```ts
console.log(tag, `完成 —— 上传=${uploaded ? "是" : "否"}，短标题=${filledTitle ? "是" : "否"}，描述=${filledDesc ? "是" : "否"}`)
```

### 2. jsdom 复现 shadow DOM 场景

不需要真的登录平台，就能验证深层查询与填充逻辑：

```js
const { JSDOM } = require("jsdom")
const dom = new JSDOM(`<!DOCTYPE html><body><div id="host"></div></body>`, {
  url: "https://channels.weixin.qq.com/platform/post/create"
})
const shadow = dom.window.document.getElementById("host").attachShadow({ mode: "open" })
shadow.innerHTML = `
  <div class="post-upload-wrap"><div class="ant-upload ant-upload-drag">
    <input type="file" accept="video/*" />
  </div></div>
  <textarea placeholder="添加描述"></textarea>
  <input placeholder="填写短标题有机会获得更多流量" />
`
// 再 stub DataTransfer / fetch / File，把 dom.window 的构造器挂到 global 上后调用适配器
```

先用 `tsc` 单独把适配器编译成 CommonJS 再 require，就能直接测试真实源码：

```bash
npx tsc src/sync/adapters/weixin-channel-video.ts \
  --outDir /tmp/xdtest --target es2020 --module commonjs --skipLibCheck --moduleResolution node
```

### 3. 检查产物是否真的打进去了

`plasmo build` 后确认适配器进了产物（中文字符串会被压缩器转成 `\uXXXX`，所以用 ASCII 选择器搜索更可靠）：

```bash
grep -rl "post-upload-wrap" build/chrome-mv3-prod/
```

改完代码一定要在 `chrome://extensions` **重新加载**扩展，否则跑的还是旧代码。

---

## 七、已适配平台速查

| 平台 | key | 图文 | 视频 | 注入页 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 抖音 | `douyin` | ✅ | ✅ | `creator.douyin.com/creator-micro/content/upload` | 不支持纯文字 |
| 小红书 | `rednote` | ✅ | ✅ | `creator.xiaohongshu.com/publish/publish` | 不支持纯文字 |
| 即刻 | `okjike` | ✅ | ✅ | `web.okjike.com` | 支持纯文字 |
| 微博 | `weibo` | ✅ | ✅ | 首页 / `weibo.com/upload/channel` | 支持纯文字 |
| 视频号 | `channels` | ❌ | ✅ | `channels.weixin.qq.com/platform/post/create` | **wujie 微前端，必须深层查询**；不支持纯文字/纯图片 |

新增平台时：

1. 在 `src/sync/adapters/` 加适配器（宁可多写日志，也别静默失败）
2. 在 `src/sync/platforms.ts` 的 `PLATFORMS` 注册（`dynamic` / `video` 两个入口，无对应模式的复用另一个并注释说明）
3. `src/components/PlatformCard.tsx` 加图标
4. `src/tabs/publish.tsx` 的 `nameLabels` 加平台名
5. `src/components/DistributePanel.tsx` 处理「该模式不可用」的禁用逻辑与提示文案
6. 同步更新 `README.md` 与本文档的速查表
