// The paint layer: a click-through window lying exactly over MS Paint's canvas, where Capri
// paints her picture (painter.ts). The finished PNG goes back to main, which saves it and opens it
// in Paint for real.
import type { PaintStart } from '@shared/types'
import { api } from '../shared/api'
import { Painter, fallbackScene } from './painter'

document.documentElement.style.cssText = 'margin:0;background:transparent;overflow:hidden'
document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden'
const canvas = document.createElement('canvas')
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;transition:opacity .5s'
document.getElementById('root')!.appendChild(canvas)

let painter: Painter | null = null
let lastBrush = 0

async function loadTemplate(bytes: Uint8Array | null, w: number, h: number): Promise<CanvasImageSource & { width: number; height: number }> {
  if (bytes) {
    try {
      return await createImageBitmap(new Blob([bytes as BlobPart]))
    } catch (e) {
      console.warn('template could not be decoded', e)
    }
  }
  return fallbackScene(w, h)
}

api.on('paint:start', async (p: PaintStart) => {
  canvas.width = p.width
  canvas.height = p.height
  canvas.style.opacity = '1'
  const source = await loadTemplate(p.template, p.width, p.height)
  painter = new Painter(canvas, source, {
    durationMs: p.durationMs,
    onBrush: (x, y) => {
      // Capri's cursor follows the brush (a few times a second is plenty).
      const now = performance.now()
      if (now - lastBrush < 350) return
      lastBrush = now
      void api.invoke('paint:brush', x / p.width, y / p.height)
    }
  })
  await painter.start()
  const blob = await painter.toBlob()
  await api.invoke('paint:done', new Uint8Array(await blob.arrayBuffer()))
  canvas.style.opacity = '0'
})

api.on('paint:finish', () => painter?.finishFast(2500))
