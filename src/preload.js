'use strict';
// The only bridge between the window and the app. Named methods only; no paths, no raw IPC.
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const channels = ['getState', 'onboard', 'discover', 'addDiscovered', 'pickFolder', 'removeProject', 'history', 'changesIn',
  'explainSavePoint', 'init', 'save', 'ignoreForever', 'push', 'pull', 'undo', 'restore', 'rescue', 'githubStatus', 'githubHome',
  'lessonRead', 'lessons', 'resetTips', 'setSettings', 'openFolder', 'refresh'];

const api = Object.fromEntries(channels.map((c) => [c, call(c)]));
api.onState = (cb) => ipcRenderer.on('state', (_e, s) => cb(s));
api.onTwig = (cb) => ipcRenderer.on('twig', (_e, s) => cb(s));

contextBridge.exposeInMainWorld('kmgit', Object.freeze(api));
