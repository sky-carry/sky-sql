import { useEffect, useRef, useState } from 'react'

/** 监听元素尺寸（glide-data-grid 需要显式像素尺寸） */
export function useElementSize<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>
  width: number
  height: number
} {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, ...size }
}
