export function imageClickToViewport(
  event: MouseEvent,
  image: HTMLImageElement | undefined,
  viewport?: { width: number, height: number },
): { kind: 'click', x: number, y: number } | undefined
