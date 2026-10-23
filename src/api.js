import { createMockApi } from './mockApi.js';

// Inside Electron the preload script provides window.dm. In a plain browser
// (UI development) a simulated backend is used instead.
export const api = window.dm ?? createMockApi();
export const isMock = !window.dm;
