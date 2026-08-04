// App shell: auth, document list, and the editor page. Deliberately plain
// JS for now — the Svelte shell arrives with the sheets work; the editor
// module itself is framework-agnostic either way.
import * as Y from 'yjs'
import { Provider } from './provider.js'
import { mountEditor, toolbarCommands } from './editor.js'
import { scheduleCompaction } from './compaction.js'

const $ = (id) => document.getElementById(id)

const cursorColors = [
  ['#30bced', '#a8dff2'], ['#6eeb83', '#c6f7cf'], ['#fa69d1', '#fcc4ea'],
  ['#ffbc42', '#ffe3b0'], ['#ecd444', '#f5edb0'], ['#ee6352', '#f8c2ba'],
  ['#9b6ef3', '#d9c6fa'], ['#1be7ff', '#b3f6ff'],
]

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

let me = null
let session = null // current editor session: {provider, view, doc}

function show(view) {
  $('authview').classList.toggle('hidden', view !== 'auth')
  $('listview').classList.toggle('hidden', view !== 'list')
  $('editorview').classList.toggle('hidden', view !== 'editor')
}

async function showList() {
  closeEditor()
  $('who').textContent = `${me.name} <${me.email}>`
  const docs = await api('/api/docs')
  const ul = $('doclist')
  ul.replaceChildren()
  for (const d of docs) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = d.title
    a.onclick = (e) => { e.preventDefault(); openDoc(d) }
    const del = document.createElement('button')
    del.textContent = 'delete'
    del.onclick = async () => {
      if (!confirm(`Delete "${d.title}"?`)) return
      await api(`/api/docs/${d.id}`, { method: 'DELETE' })
      showList()
    }
    li.append(a, document.createTextNode(d.role), del)
    ul.append(li)
  }
  show('list')
}

function openDoc(d) {
  const doc = new Y.Doc()
  const ytext = doc.getText('text')
  const provider = new Provider(doc, d.id, {
    onStatus: (s) => { $('connstatus').textContent = s },
    onSynced: (synced) => {
      if (provider.corrupted) return // never snapshot/verify from a doc that missed frames
      scheduleCompaction({ docId: d.id, doc, role: d.role, synced })
    },
  })

  const [color, colorLight] = cursorColors[doc.clientID % cursorColors.length]
  provider.awareness.setLocalStateField('user', { name: me.name, color, colorLight })
  provider.awareness.on('change', () => {
    const n = provider.awareness.getStates().size
    $('presence').textContent = n > 1 ? `${n} online` : ''
  })

  const toolbar = $('toolbar')
  toolbar.replaceChildren()
  const view = mountEditor({
    parent: $('editor'),
    ytext,
    awareness: provider.awareness,
    readOnly: d.role === 'viewer',
  })
  if (d.role !== 'viewer') {
    for (const cmd of toolbarCommands) {
      const b = document.createElement('button')
      b.textContent = cmd.label
      b.title = cmd.title
      // mousedown+preventDefault keeps focus (and the selection) in the editor
      b.onmousedown = (e) => e.preventDefault()
      b.onclick = () => cmd.run(view)
      toolbar.append(b)
    }
  }

  session = { provider, view, doc }
  $('doctitle').textContent = d.title
  show('editor')
}

function closeEditor() {
  if (!session) return
  session.view.destroy()
  session.provider.destroy()
  session.doc.destroy()
  session = null
  $('editor').replaceChildren()
}

function boot() {
  $('loginform').onsubmit = (e) => submitAuth(e, '/api/login')
  $('signupform').onsubmit = (e) => submitAuth(e, '/api/signup')
  $('logout').onclick = async (e) => {
    e.preventDefault()
    await api('/api/logout', { method: 'POST' })
    me = null
    show('auth')
  }
  $('createform').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: f.get('title') }) })
    e.target.reset()
    showList()
  }
  $('back').onclick = (e) => { e.preventDefault(); showList() }

  api('/api/me').then((u) => { me = u; showList() }).catch(() => show('auth'))
}

async function submitAuth(e, path) {
  e.preventDefault()
  const f = new FormData(e.target)
  try {
    me = await api(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(f)) })
    $('autherr').textContent = ''
    showList()
  } catch (err) {
    $('autherr').textContent = err.message
  }
}

boot()
