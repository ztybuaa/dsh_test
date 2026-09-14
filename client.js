// Browser half of the dsh-browser-use plugin: the Agent browser view.
//
// Mounted as a NATIVE dsh-better-sidebar tab when that service is available
// (ctx.get('betterSidebar') — consumed opportunistically, so the plugin still
// works when better-sidebar is not installed); otherwise it falls back to the
// legacy shell.overlay floating panel. Both host the same view: an MJPEG
// screencast of the agent's live page, with input gated behind an explicit
// takeover (「接管浏览器」 / 「交还浏览器」).
window.__ModuleLoader__.load({
  id: 'dsh-browser-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    /** Host route streaming the watched page as MJPEG (see src/mirror.ts). */
    var FRAME_STREAM = '/browser-use/frame-stream'
    /** Tab list for the strip, and the panel's WATCH switch (never the agent's page). */
    var TABS_ROUTE = '/browser-use/tabs'
    var WATCH_ROUTE = '/browser-use/watch'
    /** The one deliberate exception to "observation never disturbs the browser". */
    var SHOW_ROUTE = '/browser-use/show'
    /** Start the browser when there is none, so the panel has something to show. */
    var START_ROUTE = '/browser-use/start'
    /** How often the strip re-reads the tab list. */
    var TABS_POLL_MS = 1500

    /**
     * Post one input intention to the host.
     *
     * Never throws, but it does REPORT. The host answers 409 when nobody holds
     * takeover and 500 when a dispatch fails, and swallowing either is what made the
     * panel look simply dead when it was in fact being refused.
     */
    function postInput(payload, onFailure) {
      return fetch('/browser-use/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(readFailure)
        .catch(function (error) { return { status: 0, error: describe(error) } })
        .then(function (failure) {
          if (failure && onFailure) onFailure(failure)
          return failure
        })
    }

    /** Turn a non-2xx response into {status, error}; resolve null when it succeeded. */
    function readFailure(res) {
      if (res.ok) return null
      return res
        .json()
        .catch(function () { return {} })
        .then(function (body) {
          return { status: res.status, error: body && body.error ? String(body.error) : 'HTTP ' + res.status }
        })
    }

    function describe(error) {
      return String(error && error.message ? error.message : error)
    }

    function postTakeover(next) {
      return fetch('/browser-use/takeover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeover: next }),
      })
    }

    /**
     * Ask the host to raise the real Chrome window (and restore it first — it is
     * launched with --start-minimized). Deliberately wired to a button and nothing
     * else: the panel observes the browser, so it must never move the window on its
     * own. Resolves to null on success, or to {status, error}.
     */
    function showWindow() {
      return fetch(SHOW_ROUTE, { method: 'POST' })
        .then(readFailure)
        .catch(function (error) { return { status: 0, error: describe(error) } })
    }

    /**
     * Start the browser. Resolves once the host has one running, so the caller can
     * refresh the tab list and let the frame stream attach. Idempotent on the host.
     */
    function startBrowser() {
      return fetch(START_ROUTE, { method: 'POST' })
        .then(readFailure)
        .catch(function (error) { return { status: 0, error: describe(error) } })
    }

    /** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
    function mods(e) {
      return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
    }

    /**
     * Text and key entry for the panel.
     *
     * Ported from ego-lite's `createKeyboardProxy`, because the obvious version — one
     * `key` POST per document keydown — cannot type anything a key NAME cannot
     * express: no IME (so no Chinese or Japanese at all), no modifiers, and Shift+2
     * arrives as "2". A hidden textarea takes real focus instead, so the browser
     * produces genuine `beforeinput` and composition events: printable text leaves as
     * `insertText`, and only shortcuts and control keys become key events.
     */
    function createKeyboardProxy(send) {
      var input = document.createElement('textarea')
      input.tabIndex = -1
      input.setAttribute('autocomplete', 'off')
      input.setAttribute('autocapitalize', 'off')
      input.setAttribute('spellcheck', 'false')
      input.style.cssText =
        'position:fixed;z-index:-1;width:1px;height:1px;opacity:0;pointer-events:none;resize:none;padding:0;border:0;left:0;top:0;'
      document.body.appendChild(input)

      var composing = false
      var pressed = {}
      var lastCompositionText = ''
      var lastCompositionAt = 0

      function keyId(e) {
        return e.code || e.key
      }
      function keyPayload(e) {
        return {
          key: e.key,
          code: e.code || '',
          modifiers: mods(e),
          autoRepeat: e.repeat === true,
          windowsVirtualKeyCode: Number(e.keyCode || e.which || 0),
        }
      }
      function releaseAll() {
        Object.keys(pressed).forEach(function (id) {
          send('keyUp', Object.assign({}, pressed[id], { autoRepeat: false }))
        })
        pressed = {}
      }

      input.addEventListener('compositionstart', function (e) {
        composing = true
        e.stopPropagation()
      })
      input.addEventListener('compositionend', function (e) {
        composing = false
        e.stopPropagation()
        if (e.data) {
          lastCompositionText = e.data
          lastCompositionAt = Date.now()
          send('insertText', { text: e.data })
        }
        window.setTimeout(function () { input.value = '' }, 0)
      })
      input.addEventListener('beforeinput', function (e) {
        e.stopPropagation()
        if (composing || /Composition/i.test(e.inputType || '')) return
        // compositionend already sent this text; beforeinput repeats it immediately after.
        if (e.data && e.data === lastCompositionText && Date.now() - lastCompositionAt < 100) {
          e.preventDefault()
          return
        }
        if (e.data) {
          e.preventDefault()
          send('insertText', { text: e.data })
          input.value = ''
        }
      })
      input.addEventListener('paste', function (e) {
        var text = e.clipboardData && e.clipboardData.getData('text/plain')
        if (!text) return
        e.preventDefault()
        e.stopPropagation()
        send('insertText', { text: text })
        input.value = ''
      })
      input.addEventListener('keydown', function (e) {
        e.stopPropagation()
        if (composing || e.key === 'Process' || e.key === 'Dead') return
        // AltGr reports as Ctrl+Alt on Windows and must not be treated as a shortcut.
        if (e.getModifierState && e.getModifierState('AltGraph') && e.key.length === 1) return
        var isShortcut = e.ctrlKey || e.metaKey || e.altKey
        var isControl = e.key.length > 1
        // A printable key is left to beforeinput -> insertText, or it would be typed twice.
        if (!isShortcut && !isControl) return
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'v') return
        e.preventDefault()
        var payload = keyPayload(e)
        pressed[keyId(e)] = payload
        send('keyDown', payload)
      })
      input.addEventListener('keyup', function (e) {
        e.stopPropagation()
        var payload = pressed[keyId(e)]
        if (!payload) return
        e.preventDefault()
        delete pressed[keyId(e)]
        send('keyUp', keyPayload(e))
      })
      input.addEventListener('blur', releaseAll)

      return {
        focus: function () {
          try {
            input.focus({ preventScroll: true })
          } catch (_) {
            input.focus()
          }
        },
        blur: function () {
          releaseAll()
          input.blur()
        },
        destroy: function () {
          releaseAll()
          if (input.parentNode) input.parentNode.removeChild(input)
        },
      }
    }

    /**
     * The live browser view. Used both as a sidebar tab (fills its tab and
     * unmounts the <img> while hidden, so the host stream stops) and as the
     * legacy floating panel (fixed 1240px, always visible).
     *
     * `visible` comes from the sidebar's TabComponentProps; it is undefined for
     * the floating fallback, which is always shown.
     */
    function AgentBrowserView(props) {
      var h = react.createElement
      var visible = props.visible === undefined ? true : props.visible === true
      var floating = props.floating === true

      var takeoverState = react.useState(false)
      var takeover = takeoverState[0]
      var setTakeover = takeoverState[1]
      var tabsState = react.useState([])
      var tabs = tabsState[0]
      var setTabs = tabsState[1]
      // Distinct from `tabs.length === 0`: a browser can exist with no pages open. Both
      // buttons act on the browser, so both are disabled until there is one — a button
      // that answers "还没有浏览器" is worse than a button that is plainly unavailable.
      var hasBrowserState = react.useState(false)
      var hasBrowser = hasBrowserState[0]
      var setHasBrowser = hasBrowserState[1]
      var imgRef = react.useRef(null)
      var lastMoveRef = react.useRef(0)
      var dragRef = react.useRef(null)
      var proxyRef = react.useRef(null)
      var noteTimerRef = react.useRef(undefined)
      var noteState = react.useState('')
      var note = noteState[0]
      var setNote = noteState[1]

      function flashNote(text) {
        setNote(text)
        if (noteTimerRef.current) window.clearTimeout(noteTimerRef.current)
        noteTimerRef.current = window.setTimeout(function () { setNote('') }, 6000)
      }

      /**
       * Surface a failed host call instead of doing nothing.
       *
       * 405 gets its own line because it has exactly one cause and it is not the
       * user's fault: the client half is re-read from disk on every browser refresh,
       * while the host half only reloads when DSH restarts. A newly added route
       * therefore looks broken until the next restart, which is precisely how the
       * 显示窗口 button first appeared dead.
       */
      function reportFailure(failure) {
        if (!failure) return
        if (failure.status === 405) {
          flashNote('宿主端没有这条路由 —— 需要重启 DSH（客户端随刷新重载，宿主不会）')
          return
        }
        if (failure.status === 409) {
          flashNote('未接管：先点「接管浏览器」')
          return
        }
        flashNote('操作失败：' + failure.error)
      }

      function toggleTakeover() {
        var next = !takeover
        postTakeover(next)
          .then(function () { setTakeover(next) })
          .catch(function (error) { flashNote('切换接管失败：' + describe(error)) })
      }

      function onShowWindow() {
        showWindow().then(function (failure) {
          if (failure) reportFailure(failure)
          else flashNote('已把浏览器窗口抬到最前')
        })
      }

      /**
       * Bring a browser into existence from the panel.
       *
       * The host answers only once the browser is up, so refresh the tab list straight
       * away instead of waiting out the poll — that is what flips `hasBrowser` and lets
       * the frame stream attach.
       */
      function onStartBrowser() {
        flashNote('正在启动浏览器…')
        startBrowser().then(function (failure) {
          if (failure) {
            reportFailure(failure)
            return
          }
          fetch(TABS_ROUTE)
            .then(function (res) { return res.json() })
            .then(applyTabs)
            .catch(function () {})
        })
      }

      // A native listener rather than React's onWheel: React attaches wheel passively
      // at the root, where preventDefault() is ignored and the sidebar scrolls instead
      // of the page.
      react.useEffect(function () {
        var el = imgRef.current
        if (el === null) return undefined
        function onWheel(e) {
          if (!takeover) return
          e.preventDefault()
          e.stopPropagation()
          var p = norm(e)
          postInput({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: e.deltaX || 0, deltaY: e.deltaY || 0 }, reportFailure)
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () { el.removeEventListener('wheel', onWheel) }
      }, [visible, takeover])

      // The keyboard proxy belongs to the panel's lifetime; takeover only decides
      // whether it holds focus. Focus is taken on pointer-down (below) and never on
      // render, so an open panel does not steal keystrokes from the DSH composer.
      react.useEffect(function () {
        var proxy = createKeyboardProxy(function (type, params) {
          postInput(Object.assign({ type: type }, params), reportFailure)
        })
        proxyRef.current = proxy
        return function () {
          proxyRef.current = null
          proxy.destroy()
        }
      }, [])

      react.useEffect(function () {
        if (takeover) return undefined
        if (proxyRef.current !== null) proxyRef.current.blur()
        return undefined
      }, [takeover])

      // NO viewport sync. This panel is a convenience viewer for the agent's
      // browser: it must show the browser as it is and never resize it. Driving
      // the page's viewport from the panel's size rewrote the browser's layout on
      // every drag (the frame visibly jumped 1600 -> 682 -> 819 wide), which is
      // the panel interfering with the browser it is supposed to observe. Aspect
      // mismatch is handled by letterboxing, and norm() accounts for it.

      // Tab strip. Polls the host for the agent browser's tabs and pins the
      // WATCH — the panel's own "show me this one" — instead of moving the agent's
      // session. That separation is what ego-lite does with CaptureManager
      // .switchTarget: viewing another tab must never steer the agent's task, nor
      // raise the real browser window.
      /** The host's tab list, which doubles as the panel's only liveness signal. */
      function applyTabs(body) {
        if (!body) return
        if (Array.isArray(body.tabs)) setTabs(body.tabs)
        setHasBrowser(body.hasBrowser === true)
      }

      react.useEffect(function () {
        if (!visible) return undefined
        var cancelled = false
        function load() {
          fetch(TABS_ROUTE)
            .then(function (res) { return res.json() })
            .then(function (body) {
              if (!cancelled) applyTabs(body)
            })
            .catch(function () {})
        }
        load()
        var timer = setInterval(load, TABS_POLL_MS)
        return function () {
          cancelled = true
          clearInterval(timer)
        }
      }, [visible])

      function watchTo(index) {
        fetch(WATCH_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index: index }),
        })
          .then(function () { return fetch(TABS_ROUTE) })
          .then(function (res) { return res.json() })
          .then(applyTabs)
          .catch(function () {})
      }

      function norm(e) {
        var el = imgRef.current
        var rect = el.getBoundingClientRect()
        // The frame is letterboxed inside the <img> box (object-fit: contain), so
        // map through the rendered image area rather than the whole box —
        // otherwise every relayed click lands offset from where it was aimed.
        var nw = el.naturalWidth || rect.width
        var nh = el.naturalHeight || rect.height
        var frameAspect = nh === 0 ? 1 : nw / nh
        var boxAspect = rect.height === 0 ? frameAspect : rect.width / rect.height
        var rw = frameAspect > boxAspect ? rect.width : rect.height * frameAspect
        var rh = frameAspect > boxAspect ? rect.width / frameAspect : rect.height
        var left = rect.left + (rect.width - rw) / 2
        var top = rect.top + (rect.height - rh) / 2
        return { x: (e.clientX - left) / rw, y: (e.clientY - top) / rh }
      }

      function onPointerDown(e) {
        if (!takeover || e.button !== 0) return
        e.preventDefault()
        // Capture, so a drag keeps reporting after the pointer leaves the frame.
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch (_) {}
        if (proxyRef.current !== null) proxyRef.current.focus()
        var p = norm(e)
        dragRef.current = { pointerId: e.pointerId, at: p }
        postInput(
          { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: e.detail || 1, modifiers: mods(e) },
          reportFailure,
        )
      }

      function onPointerMove(e) {
        if (!takeover) return
        var drag = dragRef.current
        var dragging = drag !== null && drag.pointerId === e.pointerId
        if (!dragging) {
          // ego's inputBusy guard: drop a move that arrives before the last one landed.
          var now = Date.now()
          if (now - lastMoveRef.current < 24) return
          lastMoveRef.current = now
        }
        var p = norm(e)
        if (dragging) drag.at = p
        // `buttons` is what tells the page a drag is in progress; without it the page
        // sees a plain hover and text selection never starts.
        postInput({ type: 'mouseMoved', x: p.x, y: p.y, buttons: dragging ? 1 : 0 }, reportFailure)
      }

      /** Release at the last dragged position — the page never saw the pointer leave. */
      function endDrag(e) {
        var drag = dragRef.current
        if (drag === null || drag.pointerId !== e.pointerId) return
        dragRef.current = null
        var p = drag.at
        postInput(
          { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, modifiers: mods(e) },
          reportFailure,
        )
      }

      var hostStyle = floating
        ? {
            position: 'fixed',
            right: 16,
            top: 16,
            zIndex: 9999,
            width: 1240,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(20,20,26,0.97)',
            color: '#eee',
            font: '13px/1.5 system-ui, sans-serif',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            border: takeover ? '2px solid #f0b429' : '2px solid transparent',
          }
        : {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            minHeight: 0,
            background: '#14141a',
            color: '#eee',
            font: '12px/1.5 system-ui, sans-serif',
          }

      var buttonStyle = {
        border: '1px solid rgba(255,255,255,0.25)',
        background: 'transparent',
        color: '#eee',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: 6,
      }

      // With no browser there is nothing to show and nothing to take over, so the panel
      // offers the single action that makes sense rather than two dead buttons. The host
      // treats that browser as unclaimed, so the first agent to need one adopts it — a
      // second Chrome on the same profile could not start anyway.
      var actions = hasBrowser
        ? [
            h(
              'button',
              {
                type: 'button',
                key: 'show',
                onClick: onShowWindow,
                title: '把真实 Chrome 窗口抬到最前，并停在面板正在看的那个标签页',
                style: buttonStyle,
              },
              '显示窗口',
            ),
            h(
              'button',
              {
                type: 'button',
                key: 'takeover',
                onClick: toggleTakeover,
                title: '接管后你的点击和输入才会送进页面，Agent 的写入会被拦下',
                style: Object.assign({}, buttonStyle, {
                  background: takeover ? '#f0b429' : 'transparent',
                  color: takeover ? '#1a1a1a' : '#eee',
                }),
              },
              takeover ? '交还浏览器' : '接管浏览器',
            ),
          ]
        : [
            h(
              'button',
              {
                type: 'button',
                key: 'start',
                onClick: onStartBrowser,
                title: '启动 Agent 浏览器并在这里显示；之后 Agent 会直接用它，不会再开第二个',
                style: Object.assign({}, buttonStyle, { background: '#f0b429', color: '#1a1a1a' }),
              },
              '启动浏览器',
            ),
          ]

      var bar = h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            flex: '0 0 auto',
          },
        },
        h('span', { style: { fontWeight: 600 } }, takeover ? '人接管中' : 'Agent 浏览器'),
        h('div', { style: { display: 'flex', gap: 6 } }, actions),
      )

      // Tab strip: pins the WATCH (see the poll above). `watched` is the panel's
      // page and is the highlighted one; `current` is the AGENT's page and only
      // gets a dot, because the two are deliberately independent.
      var strip =
        tabs.length > 1
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 4,
                  padding: '4px 6px',
                  overflowX: 'auto',
                  flex: '0 0 auto',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                },
              },
              tabs.map(function (tab) {
                return h(
                  'button',
                  {
                    key: tab.index,
                    type: 'button',
                    title: (tab.current ? '● agent 当前页 · ' : '') + (tab.url || ''),
                    onClick: function () { watchTo(tab.index) },
                    style: {
                      flex: '0 1 auto',
                      maxWidth: 150,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      border: '1px solid ' + (tab.watched ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.12)'),
                      background: tab.watched ? 'rgba(255,255,255,0.16)' : 'transparent',
                      color: '#eee',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: '3px 8px',
                      borderRadius: 6,
                    },
                  },
                  (tab.current ? '● ' : '') + (tab.title || tab.url || 'Tab ' + tab.index),
                )
              }),
            )
          : null

      // The frame lives in a DEFINITE box. An <img> left to size itself takes the
      // frame's intrinsic width, and because that width is what the viewport sync
      // feeds back to the page, the panel locks at its first size and never grows
      // when the sidebar is widened. An absolutely-filled box breaks that loop.
      var box = h(
        'div',
        {
          style: {
            position: 'relative',
            flex: '1 1 auto',
            minHeight: 0,
            overflow: 'hidden',
            background: '#333',
          },
        },
        visible
          ? h('img', {
              ref: imgRef,
              src: FRAME_STREAM,
              draggable: false,
              onPointerDown: onPointerDown,
              onPointerMove: onPointerMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
              onLostPointerCapture: endDrag,
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
                userSelect: 'none',
                touchAction: 'none',
                cursor: takeover ? 'crosshair' : 'default',
              },
            })
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#86868b',
                },
              },
              '标签页未激活',
            ),
      )

      // Failures of host calls are reported here. Silence was the real problem: a
      // refused or unrouted call looked exactly like a button that does nothing.
      var noteBar = note
        ? h(
            'div',
            {
              style: {
                flex: '0 0 auto',
                padding: '6px 10px',
                fontSize: 12,
                color: '#f0b429',
                background: 'rgba(240,180,41,0.10)',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
              },
            },
            note,
          )
        : null

      return h('div', { style: hostStyle }, bar, noteBar, strip, box)
    }

    /** Descriptor of the sidebar tab this plugin contributes. */
    function tabDescriptor() {
      return {
        id: 'dsh-browser-use:agent-browser',
        title: 'Agent 浏览器',
        order: 60,
        single: true,
        component: AgentBrowserView,
      }
    }

    /** Read the betterSidebar service off a context, whichever accessor it exposes. */
    function readBetterSidebar(scope) {
      if (scope === undefined || scope === null) return undefined
      if (scope.betterSidebar !== undefined) return scope.betterSidebar
      return typeof scope.get === 'function' ? scope.get('betterSidebar') : undefined
    }

    function apply(ctx) {
      var removeFallback = null

      /** Legacy floating panel: the fallback for hosts without better-sidebar. */
      function mountFallback() {
        if (ctx.slots === undefined || ctx.slots === null || typeof ctx.slots.inject !== 'function') return
        var dispose = ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'browser-use-panel', order: 10 },
            function () {
              return react.createElement(AgentBrowserView, { floating: true, visible: true })
            },
          )
        })
        if (typeof dispose === 'function') removeFallback = dispose
      }

      // Mount the fallback first, then let the native tab supersede it and take
      // the floating panel back down.
      mountFallback()

      // ctx.inject() — NOT a one-shot service sample. A profile's bundle order
      // decides who boots first, and ours can precede better-sidebar's, so
      // sampling the service at apply time would miss it and strand the plugin
      // on the floating panel. Waiting on the dependency runs the callback
      // whenever the service does appear, order-independent.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['betterSidebar'], function (scope) {
          var betterSidebar = readBetterSidebar(scope)
          if (
            betterSidebar === undefined ||
            betterSidebar === null ||
            typeof betterSidebar.registerTab !== 'function'
          ) {
            return
          }
          scope.effect(function () {
            return betterSidebar.registerTab(tabDescriptor())
          })
          if (typeof removeFallback === 'function') {
            removeFallback()
            removeFallback = null
          }
        })
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
