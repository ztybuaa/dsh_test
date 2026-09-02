// Browser half of the dsh-browser-use plugin: the sidebar mirror.
// A floating 16:9 panel streams the host MJPEG screencast and relays the full
// mouse model (down/move/up = click + drag + hover) + wheel + keyboard.
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
      var imgRef = react.useRef(null)
      var hoverRef = react.useRef(false)
      var lastMoveRef = react.useRef(0)

      function norm(e) {
        var rect = imgRef.current.getBoundingClientRect()
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
      }

      react.useEffect(function () {
        var el = imgRef.current
        if (!el) return
        function onWheel(e) {
          e.preventDefault()
          postInput({ type: 'scroll', deltaY: e.deltaY })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () {
          el.removeEventListener('wheel', onWheel)
        }
      }, [open])

      react.useEffect(function () {
        function onKeyDown(e) {
          if (!hoverRef.current) return
          if (['Shift', 'Control', 'Alt', 'Meta'].indexOf(e.key) >= 0) return
          postInput({ type: 'key', key: e.key })
        }
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [])

      var onMouseDown = function (e) {
        var p = norm(e)
        postInput({ type: 'down', x: p.x, y: p.y })
      }
      var onMouseMove = function (e) {
        var now = Date.now()
        if (now - lastMoveRef.current < 30) return
        lastMoveRef.current = now
        var p = norm(e)
        postInput({ type: 'move', x: p.x, y: p.y })
      }
      var onMouseUp = function (e) {
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
          h('span', { style: { fontWeight: 600 } }, 'browser-use mirror'),
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
          style: { width: '100%', display: 'block', background: '#333', cursor: 'auto' },
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
