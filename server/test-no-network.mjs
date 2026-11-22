// Preloaded by `npm test`: tests must not depend on live third-party APIs.
// Those calls made runs flaky (an Open-Meteo 429 once decided a result) and
// spent quota. Tests that need a provider mock `fetch` themselves.
const realFetch = globalThis.fetch;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOCAL.has(url.hostname)) {
    throw new TypeError(`Test tried to reach ${url.hostname}; mock fetch instead.`);
  }
  return realFetch(input, init);
};
