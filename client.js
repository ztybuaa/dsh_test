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

    /** Host route streaming the agent's live page as MJPEG (see src/mirror.ts). */
    var FRAME_STREAM = '/browser-use/frame-stream'

    function postInput(payload) {
      fetch('/browser-use/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {})
    }

    function postTakeover(next) {
      return fetch('/browser-use/takeover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ takeover: next }),
      })
    }

    /** Tell the host what size the agent's page should be, so the frame fills the panel. */
    function postViewport(width, height) {
      fetch('/browser-use/viewport', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
      }).catch(function () {})
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
      var imgRef = react.useRef(null)
      /** The definite-size frame box; the viewport sync observes THIS, not the img. */
      var boxRef = react.useRef(null)
      var hoverRef = react.useRef(false)
      var lastMoveRef = react.useRef(0)

      function toggleTakeover() {
        var next = !takeover
        postTakeover(next)
          .then(function () { setTakeover(next) })
          .catch(function () {})
      }

      react.useEffect(function () {
        var el = imgRef.current
        if (el === null) return undefined
        function onWheel(e) {
          if (!takeover) return
          e.preventDefault()
          postInput({ type: 'scroll', deltaY: e.deltaY })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () { el.removeEventListener('wheel', onWheel) }
      }, [visible, takeover])

      react.useEffect(function () {
        function onKeyDown(e) {
          if (!takeover || !hoverRef.current) return
          if (['Shift', 'Control', 'Alt', 'Meta'].indexOf(e.key) >= 0) return
          postInput({ type: 'key', key: e.key })
        }
        document.addEventListener('keydown', onKeyDown)
        return function () { document.removeEventListener('keydown', onKeyDown) }
      }, [takeover])

      // Keep the page the size of the panel's content box. A page viewport that
      // matches the panel makes the screencast fill it (no letterbox) and keeps
      // relayed pointer coordinates exact. Observed on the BOX, not the img: the
      // img is sized by the frame, so feeding its size back would lock the panel.
      react.useEffect(function () {
        var el = boxRef.current
        if (el === null || !visible) return undefined
        var last = ''
        function sync() {
          var rect = el.getBoundingClientRect()
          var w = Math.round(rect.width)
          var h = Math.round(rect.height)
          if (w <= 0 || h <= 0) return
          var key = w + 'x' + h
          if (key === last) return
          last = key
          postViewport(w, h)
        }
        sync()
        var observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null
        if (observer !== null) observer.observe(el)
        window.addEventListener('resize', sync)
        return function () {
          if (observer !== null) observer.disconnect()
          window.removeEventListener('resize', sync)
        }
      }, [visible])

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

      function onMouseDown(e) {
        if (!takeover) return
        var p = norm(e)
        postInput({ type: 'down', x: p.x, y: p.y })
      }

      function onMouseMove(e) {
        if (!takeover) return
        var now = Date.now()
        if (now - lastMoveRef.current < 30) return
        lastMoveRef.current = now
        var p = norm(e)
        postInput({ type: 'move', x: p.x, y: p.y })
      }

      function onMouseUp(e) {
        if (!takeover) return
        var p = norm(e)
        postInput({ type: 'up', x: p.x, y: p.y })
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
        h(
          'button',
          {
            type: 'button',
            onClick: toggleTakeover,
            style: {
              border: '1px solid rgba(255,255,255,0.25)',
              background: takeover ? '#f0b429' : 'transparent',
              color: takeover ? '#1a1a1a' : '#eee',
              cursor: 'pointer',
              fontSize: '12px',
              padding: '4px 10px',
              borderRadius: 6,
            },
          },
          takeover ? '交还浏览器' : '接管浏览器',
        ),
      )

      // The frame lives in a DEFINITE box. An <img> left to size itself takes the
      // frame's intrinsic width, and because that width is what the viewport sync
      // feeds back to the page, the panel locks at its first size and never grows
      // when the sidebar is widened. An absolutely-filled box breaks that loop.
      var box = h(
        'div',
        {
          ref: boxRef,
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
              onMouseDown: onMouseDown,
              onMouseMove: onMouseMove,
              onMouseUp: onMouseUp,
              onMouseEnter: function () { hoverRef.current = true },
              onMouseLeave: function () { hoverRef.current = false },
              style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                display: 'block',
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

      return h('div', { style: hostStyle }, bar, box)
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
