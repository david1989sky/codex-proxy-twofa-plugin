export function createRequestGate() {
  let pending
  return {
    run(request) {
      if (pending)
        return pending
      pending = Promise.resolve().then(request).finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}
