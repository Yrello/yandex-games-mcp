export function createBrowserLifecycle(createClient) {
  let client;
  let starting;

  return {
    start() {
      if (!starting) {
        const candidate = createClient();
        client = candidate;
        starting = Promise.resolve().then(() => candidate.start()).then(() => candidate)
          .catch(async error => {
            try { await candidate.close(); } catch { /* preserve the startup error */ }
            if (client === candidate) {
              client = undefined;
              starting = undefined;
            }
            throw error;
          });
      }
      return starting;
    },

    async close() {
      try { await starting; } catch { /* startup may have failed */ }
      await client?.close();
    },
  };
}
