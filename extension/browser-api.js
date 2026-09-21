/* Shared storage for Chrome, Safari and the paste-text companion page. */
const extensionApi = globalThis.browser || globalThis.chrome;
const isExtension = Boolean(extensionApi?.runtime?.id);
if (isExtension && !globalThis.chrome) {
  globalThis.chrome = extensionApi;
}

const webStore = {
  async get(keys) {
    const names = typeof keys === "string" ? [keys] : Object.keys(keys);
    const result = {};
    for (const name of names) {
      const saved = localStorage.getItem(`vital:${name}`);
      result[name] =
        saved == null
          ? typeof keys === "object"
            ? keys[name]
            : undefined
          : JSON.parse(saved);
    }
    return result;
  },
  async set(values) {
    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(`vital:${key}`, JSON.stringify(value));
    }
  },
  async remove(key) {
    localStorage.removeItem(`vital:${key}`);
  },
};

const localStore = isExtension ? extensionApi.storage.local : webStore;
const sessionStore = isExtension
  ? extensionApi.storage.session || extensionApi.storage.local
  : webStore;
