export function createRequestGate(): {
  run: <T>(request: () => Promise<T>) => Promise<T>
}
