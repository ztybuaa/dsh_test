// Browser half of the dsh-browser-use plugin: the sidebar mirror.
// A floating 16:9 panel streams the host MJPEG screencast (read-only in Iter 1).
window.__ModuleLoader__.load({
  id: 'dsh-browser-use',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    function BrowserPanel() {
      var h = react.createElement
      var openState = react.useState(true)
      var open = openState[0]
      var setOpen = openState[1]

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
          src: '/browser-use/frame-stream',
          style: { width: '100%', display: 'block', background: '#333' },
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
