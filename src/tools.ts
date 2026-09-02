import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { basename, resolve } from 'node:path'
import { BrowserSessionManager, formatSnapshot, type PageSnapshot } from './session.ts'

/** The canonical output shape shared by navigate and snapshot. */
const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    elements: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'number', required: true },
          role: { type: 'string', required: true },
          name: { type: 'string', required: true },
          state: { type: 'string' },
        },
      },
    },
    notice: { type: 'string' },
    truncated: { type: 'boolean' },
    changes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        added: { type: 'array', items: { type: 'string' } },
        removed: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const

/** The canonical output shape for click/type/close acknowledgements. */
const okSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  },
} as const

function renderSnapshot(_args: unknown, value: PageSnapshot): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: formatSnapshot(value) }]
}

function renderOk(_args: unknown, value: { message: string }): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value.message }]
}

/** Resolve the requested screenshot path, defaulting under `screenshotDir`. */
function screenshotPath(screenshotDir: string, requested?: string): string {
  if (requested !== undefined && requested.trim() !== '') return resolve(requested)
  return resolve(screenshotDir, `browser-${Date.now()}.png`)
}

/** The schema-shaped (unbranded) image metadata a screenshot outcome carries. */
interface ScreenshotImageMeta {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** Canonical screenshot outcome: the saved file path plus its durable image reference. */
interface ScreenshotValue {
  path: string
  image: ScreenshotImageMeta
}

/** The screenshot output schema: a path plus a durable image reference. */
const screenshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'number', required: true },
        width: { type: 'number', required: true },
        height: { type: 'number', required: true },
        name: { type: 'string' },
      },
      required: true,
    },
  },
} as const

/** Brand the schema-shaped image metadata into the durable reference an image block carries. */
function imageRefFromMeta(image: ScreenshotImageMeta): ImageAttachmentRef {
  return {
    attachmentId: image.attachmentId as AttachmentId,
    mediaType: image.mediaType as ImageMediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name !== undefined ? { name: image.name } : {}),
  }
}

/** Project a screenshot outcome to model content: a path line plus the image block. */
function renderScreenshot(_args: unknown, value: ScreenshotValue): ContentBlock[] {
  return [
    { type: 'text', text: `Screenshot saved to: ${value.path}` },
    { type: 'image', attachment: imageRefFromMeta(value.image) },
  ]
}

/** Register the browser tools against a session manager. */
export function browserTools(manager: BrowserSessionManager, screenshotDir: string, attachments: AttachmentStore): ToolDefinition[] {
  return [
    defineTool({
      name: 'browser_navigate',
      description: 'Open a URL in the browser and return an accessibility snapshot of the loaded page: title, URL, and indexed interactive elements.',
      parameters: {
        url: { type: 'string', required: true, description: 'The absolute URL to open' },
      },
      output: { schema: snapshotSchema, render: renderSnapshot },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        const notice = manager.takeRecreateNotice()
        await session.navigate(args.url)
        return { ...(await session.snapshot()), ...(notice ? { notice } : {}) }
      },
    }),
    defineTool({
      name: 'browser_snapshot',
      description: 'Return an accessibility snapshot of the current page: indexed interactive elements you can click or type into by their ref.',
      parameters: {},
      output: { schema: snapshotSchema, render: renderSnapshot },
      async execute(_args, exec) {
        const session = await manager.requireSession(exec.agent)
        const notice = manager.takeRecreateNotice()
        return { ...(await session.snapshot()), ...(notice ? { notice } : {}) }
      },
    }),
    defineTool({
      name: 'browser_click',
      description: 'Click the interactive element referenced by `ref` from the most recent snapshot.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the element from the snapshot' },
      },
      output: { schema: okSchema, render: renderOk },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        const notice = manager.takeRecreateNotice()
        await session.click(args.ref)
        return { ok: true, message: notice ? `${notice} clicked ref ${args.ref}` : `clicked ref ${args.ref}` }
      },
    }),
    defineTool({
      name: 'browser_type',
      description: 'Type text into the input referenced by `ref` from the most recent snapshot.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the input from the snapshot' },
        text: { type: 'string', required: true, description: 'The text to type' },
      },
      output: { schema: okSchema, render: renderOk },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        const notice = manager.takeRecreateNotice()
        await session.type(args.ref, args.text)
        return { ok: true, message: notice ? `${notice} typed into ref ${args.ref}` : `typed into ref ${args.ref}` }
      },
    }),
    defineTool({
      name: 'browser_press_key',
      description: 'Press a keyboard key on the current page (e.g. Enter to submit a form, Escape to close a modal, Tab to move focus).',
      parameters: {
        key: { type: 'string', required: true, description: 'The key to press, e.g. Enter, Escape, Tab, ArrowDown' },
      },
      output: { schema: okSchema, render: renderOk },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        await session.pressKey(args.key)
        return { ok: true, message: `pressed ${args.key}` }
      },
    }),
    defineTool({
      name: 'browser_wait',
      description: 'Wait for page content to appear: a fixed delay (ms), a visible CSS selector, or body text. Use after navigate/click when content loads asynchronously.',
      parameters: {
        ms: { type: 'number', description: 'Wait this many milliseconds' },
        selector: { type: 'string', description: 'Wait until this CSS selector becomes visible' },
        text: { type: 'string', description: 'Wait until this text appears in the page body' },
        timeout: { type: 'number', description: 'Max wait in ms; defaults to timeoutMs' },
      },
      output: { schema: okSchema, render: renderOk },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        await session.wait({ ms: args.ms, selector: args.selector, text: args.text, timeout: args.timeout })
        return { ok: true, message: 'waited' }
      },
    }),
    defineTool({
      name: 'browser_hover',
      description: 'Hover the interactive element referenced by `ref` (reveals tooltips and hover states).',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the element from the snapshot' },
      },
      output: { schema: okSchema, render: renderOk },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        await session.hover(args.ref)
        return { ok: true, message: `hovered ref ${args.ref}` }
      },
    }),
    defineTool({
      name: 'browser_evaluate',
      description: 'Evaluate a read-only JavaScript expression in the page (e.g. window.__state, document.title) and return the result. Use when data lives in JS state rather than visible text.',
      parameters: {
        expression: { type: 'string', required: true, description: 'A JavaScript expression to evaluate, e.g. JSON.stringify(window.__data)' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        const value = await session.evaluate(args.expression)
        return typeof value === 'string' ? value : JSON.stringify(value)
      },
    }),
    defineTool({
      name: 'browser_json',
      description: 'Return the JSON data the current page has loaded via API requests (fetch/XHR). Use when the page loads data asynchronously or fails to render it — the underlying data is often still present in these responses.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(_args, exec) {
        const session = await manager.requireSession(exec.agent)
        const text = JSON.stringify(session.getJsonResponses().map((e) => ({ url: e.url.slice(0, 200), body: e.body })))
        return text.length > 20000 ? `${text.slice(0, 20000)}\n…(truncated)` : text
      },
    }),
    defineTool({
      name: 'browser_download',
      description: 'Click the element referenced by `ref` and capture the triggered file download; saves it and returns its path plus a content preview.',
      parameters: {
        ref: { type: 'number', required: true, description: 'The 1-based ref of the download link/button from the snapshot' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            preview: { type: 'string', required: true },
          },
        },
        render: (_args, value: { path: string; preview: string }) => [
          { type: 'text', text: `Downloaded to: ${value.path}\nPreview:\n${value.preview}` },
        ],
      },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        return await session.download(args.ref, screenshotDir)
      },
    }),
    defineTool({
      name: 'browser_scroll',
      description: 'Scroll the page up or down by a pixel amount.',
      parameters: {
        direction: { type: 'string', required: true, description: 'Either "up" or "down"' },
        amount: { type: 'number', description: 'Pixels to scroll; defaults to 500' },
      },
      output: { schema: okSchema, render: renderOk },
      async execute(args, exec) {
        if (args.direction !== 'up' && args.direction !== 'down') {
          throw new Error(`browser-use: direction must be "up" or "down", got "${args.direction}"`)
        }
        const session = await manager.requireSession(exec.agent)
        await session.scroll(args.direction, args.amount ?? 500)
        return { ok: true, message: `scrolled ${args.direction}` }
      },
    }),
    defineTool({
      name: 'browser_screenshot',
      description: 'Capture the current page as a PNG, save it, and return the image itself plus its absolute path.',
      parameters: {
        path: { type: 'string', description: 'Optional file path for the PNG; defaults to browser-<timestamp>.png under the screenshot dir' },
      },
      output: { schema: screenshotSchema, render: renderScreenshot },
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        const path = screenshotPath(screenshotDir, args.path)
        const data = await session.screenshot(path)
        const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(path) })
        return {
          path,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          },
        }
      },
    }),
    defineTool({
      name: 'browser_extract',
      description: 'Extract the visible text content of the current page.',
      parameters: {
        mode: { type: 'string', description: 'Extraction mode; only "text" is supported for now' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        const session = await manager.requireSession(exec.agent)
        return await session.extractText()
      },
    }),
    defineTool({
      name: 'browser_close',
      description: 'Close the current browser session and release its resources. A later browser tool starts a fresh session.',
      parameters: {},
      output: { schema: okSchema, render: renderOk },
      async execute(_args, exec) {
        const closed = await manager.closeSession(exec.agent)
        return { ok: true, message: closed ? 'browser session closed' : 'no active browser session to close' }
      },
    }),
  ]
}
