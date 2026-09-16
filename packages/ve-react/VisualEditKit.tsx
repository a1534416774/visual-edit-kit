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
      init: (o: Record<string, unknown>) => { setRoute?: (route: string) => void } | undefined;
      reset: () => void;
    };
  }
}

/**
 * 薄封装：把框架无关的 ve-core 挂到任何 React 应用。
 * 不依赖任何 UI 库，只负责在挂载时加载并初始化 core、按 route 切换方案。
 *
 * 关键：引擎初始化只做一次（init 会挂监听器/UI，重复调用会泄漏）；
 * route 变化时调用引擎的 setRoute() 切换当前方案（保存旧路由、加载新路由），
 * 从而实现「每个页面独立方案、刷新不丢」。
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
  const apiRef = useRef<{ setRoute?: (route: string) => void } | null>(null);

  // 仅挂载一次：加载并初始化引擎
  useEffect(() => {
    let cancelled = false;

    const boot = () => {
      if (cancelled) return;
      const w = window;
      const doInit = () => {
        if (w.VisualEditKit) apiRef.current = w.VisualEditKit.init({ route, serverUrl, token, pickMode, features, autoFetch });
      };
      if (w.VisualEditKit) doInit();
      else if (ref.current) {
        const s = document.createElement('script');
        s.src = coreSrc;
        s.onload = doInit;
        document.head.appendChild(s);
      }
    };

    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });

    return () => {
      cancelled = true;
    };
    // 仅初始化一次；route 变化走下方 setRoute 副作用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // route 变化：仅切换引擎内部 route（不重 init）
  useEffect(() => {
    if (apiRef.current && typeof apiRef.current.setRoute === 'function') {
      apiRef.current.setRoute(route);
    }
  }, [route]);

  return <div ref={ref} data-ve-react-mount style={{ display: 'none' }} />;
}

export default VisualEditKit;
