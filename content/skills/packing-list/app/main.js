import { mount } from 'svelte';
import App from './App.svelte';

document.title = window.PACKING_TRIP.pageTitle;
mount(App, { target: document.querySelector('[data-app]') });
