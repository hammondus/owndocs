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
  for (const v of ['authview', 'listview', 'editorview', 'shareview']) {
    $(v).classList.toggle('hidden', v !== view + 'view')
  }
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
    li.append(a, document.createTextNode(d.role))
    if (d.role === 'owner') {
      const share = document.createElement('button')
      share.textContent = 'share'
      share.onclick = () => showShare(d)
      const del = document.createElement('button')
      del.textContent = 'delete'
      del.onclick = async () => {
        if (!confirm(`Delete "${d.title}"?`)) return
        await api(`/api/docs/${d.id}`, { method: 'DELETE' })
        showList()
      }
      li.append(share, del)
    }
    ul.append(li)
  }
  location.hash = ''
  show('list')
}

// ---- sharing --------------------------------------------------------------

async function showShare(d) {
  closeEditor()
  $('sharetitle').textContent = d.title
  $('shareerr').textContent = ''
  $('newlink').classList.add('hidden')
  $('shareback').onclick = (e) => { e.preventDefault(); showList() }

  const renderPeople = async () => {
    const shares = await api(`/api/docs/${d.id}/shares`)
    const ul = $('sharelist')
    ul.replaceChildren()
    for (const s of shares) {
      const li = document.createElement('li')
      li.append(document.createTextNode(`${s.name} <${s.email}> — ${s.role}`))
      if (s.role !== 'owner') {
        const rm = document.createElement('button')
        rm.textContent = 'remove'
        rm.onclick = async () => {
          await api(`/api/docs/${d.id}/shares/${s.user_id}`, { method: 'DELETE' })
          renderPeople()
        }
        li.append(rm)
      }
      ul.append(li)
    }
  }
  const renderLinks = async () => {
    const links = await api(`/api/docs/${d.id}/links`)
    const ul = $('linklist')
    ul.replaceChildren()
    for (const l of links) {
      const li = document.createElement('li')
      const when = new Date(l.created_at * 1000).toLocaleString()
      li.append(document.createTextNode(`${l.role} link, created ${when} `))
      const rm = document.createElement('button')
      rm.textContent = 'revoke'
      rm.onclick = async () => {
        await api(`/api/docs/${d.id}/links/${l.id}`, { method: 'DELETE' })
        renderLinks()
      }
      li.append(rm)
      ul.append(li)
    }
  }

  $('shareform').onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    try {
      await api(`/api/docs/${d.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({ email: f.get('email'), role: f.get('role') }),
      })
      e.target.reset()
      $('shareerr').textContent = ''
      renderPeople()
    } catch (err) {
      $('shareerr').textContent = err.message
    }
  }
  const mklink = (role) => async () => {
    const l = await api(`/api/docs/${d.id}/links`, { method: 'POST', body: JSON.stringify({ role }) })
    $('newlinkurl').value = `${location.origin}/#share=${l.token}`
    $('newlink').classList.remove('hidden')
    renderLinks()
  }
  $('mklink-viewer').onclick = mklink('viewer')
  $('mklink-editor').onclick = mklink('editor')
  $('copylink').onclick = () => {
    navigator.clipboard?.writeText($('newlinkurl').value)
    $('newlinkurl').select()
  }

  await Promise.all([renderPeople(), renderLinks()])
  show('share')
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
  $('sharebtn').classList.toggle('hidden', d.role !== 'owner')
  $('sharebtn').onclick = (e) => { e.preventDefault(); showShare(d) }
  location.hash = 'doc=' + d.id
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

  api('/api/me').then((u) => { me = u; return afterAuth() }).catch(() => show('auth'))
}

// Route on the location hash once signed in: #share=<token> redeems a share
// link, #doc=<id> reopens a document (survives refresh), else the list.
async function afterAuth() {
  const hash = new URLSearchParams(location.hash.slice(1))
  if (hash.get('share')) {
    try {
      const d = await api('/api/share/redeem', {
        method: 'POST',
        body: JSON.stringify({ token: hash.get('share') }),
      })
      openDoc(d)
      return
    } catch (err) {
      alert(err.message) // invalid/revoked link; fall through to the list
    }
  } else if (hash.get('doc')) {
    const docs = await api('/api/docs')
    const d = docs.find((x) => x.id === hash.get('doc'))
    if (d) {
      openDoc(d)
      return
    }
  }
  showList()
}

async function submitAuth(e, path) {
  e.preventDefault()
  const f = new FormData(e.target)
  try {
    me = await api(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(f)) })
    $('autherr').textContent = ''
    // afterAuth, not showList: a share link opened while signed out must be
    // redeemed right after signing in — the hash survives the auth flow.
    afterAuth()
  } catch (err) {
    $('autherr').textContent = err.message
  }
}

boot()
