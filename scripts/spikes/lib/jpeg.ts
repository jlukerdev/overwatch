// Minimal JPEG header reader: width/height from the first SOFn marker. Pure.

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

export function jpegSize(buf: Uint8Array): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined
    const marker = buf[i + 1] ?? 0
    if (marker === 0xff) {
      i += 1 // fill byte
      continue
    }
    const len = view.getUint16(i + 2)
    if (SOF_MARKERS.has(marker)) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
    }
    i += 2 + len
  }
  return undefined
}
