// Browser half of the dsh-browser-use plugin: the sidebar mirror.
// A floating 16:9 panel streams the host MJPEG screencast. Input is gated by an
// explicit takeover: click 「接管浏览器」 to drive the page, 「交还浏览器」 to hand it back.
window.__ModuleLoader__.load({
  id: 'dsh-browser-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    function postInput(payload) {
      fetch('/browser-use/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {})
    }

    function BrowserPanel() {
      var h = react.createElement
      var openState = react.useState(true)
      var open = openState[0]
      var setOpen = openState[1]
      var takeoverState = react.useState(false)
      var takeover = takeoverState[0]
      var setTakeover = takeoverState[1]
      var imgRef = react.useRef(null)
      var hoverRef = react.useRef(false)
      var lastMoveRef = react.useRef(0)

      function norm(e) {
        var rect = imgRef.current.getBoundingClientRect()
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
      }

      function toggleTakeover() {
        var next = !takeover
        fetch('/browser-use/takeover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ takeover: next }),
        })
          .then(function () {
            setTakeover(next)
          })
          .catch(function () {})
      }

      react.useEffect(function () {
        var el = imgRef.current
        if (!el) return
        function onWheel(e) {
          if (!takeover) return
          e.preventDefault()
          postInput({ type: 'scroll', deltaY: e.deltaY })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () {
          el.removeEventListener('wheel', onWheel)
        }
      }, [open, takeover])

      react.useEffect(function () {
        function onKeyDown(e) {
          if (!takeover || !hoverRef.current) return
          if (['Shift', 'Control', 'Alt', 'Meta'].indexOf(e.key) >= 0) return
          postInput({ type: 'key', key: e.key })
        }
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [takeover])

      var onMouseDown = function (e) {
        if (!takeover) return
        var p = norm(e)
        postInput({ type: 'down', x: p.x, y: p.y })
      }
      var onMouseMove = function (e) {
        if (!takeover) return
        var now = Date.now()
        if (now - lastMoveRef.current < 30) return
        lastMoveRef.current = now
        var p = norm(e)
        postInput({ type: 'move', x: p.x, y: p.y })
      }
      var onMouseUp = function (e) {
        if (!takeover) return
        var p = norm(e)
        postInput({ type: 'up', x: p.x, y: p.y })
      }

      if (!open) {
        return h(
          'button',
          {
            onClick: function () {
              setOpen(true)
            },
            'aria-label': 'open browser mirror',
            style: {
              position: 'fixed',
              right: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 9999,
              width: 22,
              height: 72,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRight: 'none',
              borderRadius: '12px 0 0 12px',
              background: 'rgba(20,20,26,0.9)',
              color: '#eee',
              cursor: 'pointer',
              fontSize: '12px',
            },
          },
          '◀',
        )
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            top: 16,
            zIndex: 9999,
            width: 720,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(20,20,26,0.97)',
            color: '#eee',
            font: '13px/1.5 system-ui, sans-serif',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            border: takeover ? '2px solid #f0b429' : '2px solid transparent',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.1)',
            },
          },
          h('span', { style: { fontWeight: 600 } }, takeover ? '人接管中' : 'browser-use mirror'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(
              'button',
              {
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
            h(
              'button',
              {
                onClick: function () {
                  setOpen(false)
                },
                'aria-label': 'close browser mirror',
                style: {
                  border: 'none',
                  background: 'none',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '2px 6px',
                },
              },
              '✕',
            ),
          ),
        ),
        h('img', {
          ref: imgRef,
          src: '/browser-use/frame-stream',
          onMouseDown: onMouseDown,
          onMouseMove: onMouseMove,
          onMouseUp: onMouseUp,
          onMouseEnter: function () {
            hoverRef.current = true
          },
          onMouseLeave: function () {
            hoverRef.current = false
          },
          style: { width: '100%', display: 'block', background: '#333', cursor: takeover ? 'crosshair' : 'auto' },
        }),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'browser-use-panel', order: 10 }, BrowserPanel),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
