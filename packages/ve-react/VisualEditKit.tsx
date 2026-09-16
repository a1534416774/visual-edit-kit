import { useEffect, useRef } from 'react';

export interface VisualEditKitProps {
  /** 方案隔离键，通常传 location.pathname */
  route: string;
  /** 后端落盘地址，例如 /api/visual-edit；不传则只本地预览 */
  serverUrl?: string;
  token?: string;
  pickMode?: 'click' | 'hover';
  features?: Array<'text' | 'color' | 'hide' | 'move' | 'token' | 'delete' | 'layout' | 'style' | 'tree' | 'comment' | 'add' | 'duplicate' | 'variants'>;
  /** ve-core.js 的加载路径（放到 public/vendor 下） */
  coreSrc?: string;
  /** 启动后是否自动从后端拉取团队方案 */
  autoFetch?: boolean;
}

declare global {
  interface Window {
    VisualEditKit?: {
      init: (o: Record<string, unknown>) => unknown;
      reset: () => void;
    };
  }
}

/**
 * 薄封装：把框架无关的 ve-core 挂到任何 React 应用。
 * 不依赖任何 UI 库，只负责在挂载时加载并初始化 core、卸载时清理。
 */
export function VisualEditKit({
  route,
  serverUrl,
  token,
  pickMode = 'click',
  features = ['text', 'color', 'hide', 'move', 'token', 'delete', 'layout', 'style', 'tree', 'comment', 'add', 'duplicate', 'variants'],
  coreSrc = '/vendor/ve-core.js',
  autoFetch = true,
}: VisualEditKitProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const boot = () => {
      if (cancelled) return;
      const w = window;
      if (w.VisualEditKit) {
        w.VisualEditKit.init({ route, serverUrl, token, pickMode, features, autoFetch });
      } else if (ref.current) {
        const s = document.createElement('script');
        s.src = coreSrc;
        s.onload = () =>
          w.VisualEditKit &&
          w.VisualEditKit.init({ route, serverUrl, token, pickMode, features, autoFetch });
        document.head.appendChild(s);
      }
    };

    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });

    return () => {
      cancelled = true;
    };
  }, [route, serverUrl, token, pickMode, features, coreSrc, autoFetch]);

  return <div ref={ref} data-ve-react-mount style={{ display: 'none' }} />;
}

export default VisualEditKit;
