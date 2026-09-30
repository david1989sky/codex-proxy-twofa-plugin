const defaultViewport = { width: 1024, height: 768 }

export function imageClickToViewport(event, image, viewport = defaultViewport) {
  if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY))
    return

  const rect = image?.getBoundingClientRect?.()
  const naturalWidth = Number(image?.naturalWidth)
  const naturalHeight = Number(image?.naturalHeight)
  if (!rect || rect.width <= 0 || rect.height <= 0 || naturalWidth <= 0 || naturalHeight <= 0)
    return

  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
  const contentWidth = naturalWidth * scale
  const contentHeight = naturalHeight * scale
  const offsetX = (rect.width - contentWidth) / 2
  const offsetY = (rect.height - contentHeight) / 2
  const imageX = event.clientX - rect.left - offsetX
  const imageY = event.clientY - rect.top - offsetY
  if (imageX < 0 || imageY < 0 || imageX >= contentWidth || imageY >= contentHeight)
    return

  return {
    kind: 'click',
    x: Math.min(viewport.width - 1, Math.max(0, Math.round(imageX / scale * viewport.width / naturalWidth))),
    y: Math.min(viewport.height - 1, Math.max(0, Math.round(imageY / scale * viewport.height / naturalHeight))),
  }
}
