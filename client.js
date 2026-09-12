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

      function norm(e) {
        var rect = imgRef.current.getBoundingClientRect()
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
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

      if (!visible) {
        // Unmounted intentionally: with no <img> there is no MJPEG consumer, so
        // the host route's `req.on('close')` stops the screencast.
        return h(
          'div',
          { style: hostStyle },
          bar,
          h(
            'div',
            {
              style: {
                flex: '1 1 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#86868b',
              },
            },
            '标签页未激活',
          ),
        )
      }

      return h(
        'div',
        { style: hostStyle },
        bar,
        h('img', {
          ref: imgRef,
          src: FRAME_STREAM,
          onMouseDown: onMouseDown,
          onMouseMove: onMouseMove,
          onMouseUp: onMouseUp,
          onMouseEnter: function () { hoverRef.current = true },
          onMouseLeave: function () { hoverRef.current = false },
          style: {
            width: '100%',
            flex: '1 1 auto',
            minHeight: 0,
            objectFit: 'contain',
            display: 'block',
            background: '#333',
            cursor: takeover ? 'crosshair' : 'default',
          },
        }),
      )
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

    function apply(ctx) {
      var betterSidebar = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined
      if (
        betterSidebar !== undefined &&
        betterSidebar !== null &&
        typeof betterSidebar.registerTab === 'function'
      ) {
        ctx.effect(function () {
          return betterSidebar.registerTab(tabDescriptor())
        })
        return
      }

      // No better-sidebar: keep the legacy floating panel, and never throw when
      // the shell slots service is missing too.
      if (ctx.slots === undefined || ctx.slots === null || typeof ctx.slots.inject !== 'function') return
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'browser-use-panel', order: 10 },
          function () {
            return react.createElement(AgentBrowserView, { floating: true, visible: true })
          },
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
