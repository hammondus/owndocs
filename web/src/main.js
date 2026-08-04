// Entry point: global CSS, then mount the root component.
// Svelte 5 uses mount() instead of `new App(...)` (the Svelte 4 way).
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

mount(App, { target: document.getElementById('app') })
