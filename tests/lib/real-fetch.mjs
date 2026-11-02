// The simulators replace globalThis.fetch with a stub that fails and lists every read (so a test notices a network
// read it did not mean to make). This module, imported before them, keeps the real one for tests that talk to localhost.
export const realFetch = globalThis.fetch;
