// Entry point: global CSS, then mount the root component.
// Svelte 5 uses mount() instead of `new App(...)` (the Svelte 4 way).
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { load, apply } from './prefs.js'

// Reading preferences are a display choice, so they apply before the first
// paint rather than after some component thinks to ask for them.
apply(load())

mount(App, { target: document.getElementById('app') })
