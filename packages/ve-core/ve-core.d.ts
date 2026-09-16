// Type declarations for visual-edit-kit ve-core (UMD / CommonJS).
// Usage: `import { VisualEditKit } from 'visual-edit-kit/ve-core'` or via <script> (window.VisualEditKit)

export type ChangeKind = 'style' | 'text' | 'hide' | 'move' | 'moveTo' | 'delete' | 'token' | 'comment' | 'add';
export type Feature = 'text' | 'color' | 'hide' | 'move' | 'token' | 'delete' | 'layout' | 'style' | 'tree' | 'comment' | 'add' | 'duplicate' | 'variants';
export type PickMode = 'click' | 'hover';
export type AddPosition = 'before' | 'after' | 'inside';

export interface Change {
  id: string;
  path: string;
  prop: string;
  value: string | number;
  kind: ChangeKind;
  position?: AddPosition;
  refId?: string;
  targetId?: string;
  targetPath?: string;
  /** 目标元素 tag 指纹（如 'header'/'div'）。跨刷新重放时用于校验解析出的元素是否仍是同一个，避免套错元素。 */
  fp?: string;
}

export interface Plan {
  route: string;
  changes: Change[];
}

export interface InitOptions {
  route?: string;
  serverUrl?: string | null;
  token?: string | null;
  features?: Feature[];
  pickMode?: PickMode;
  autoFetch?: boolean;
}

export interface VisualEditKitAPI {
  init(options?: InitOptions): VisualEditKitAPI;
  getPlan(): Plan;
  exportCSS(): string;
  exportJSON(): string;
  exportAI(): string;
  save(): Promise<boolean>;
  reset(): void;
  /** 救急：清空本页全部改动（本机记录 + 默认同时清后端），页面立刻恢复原样 */
  clearPlan(alsoRemote?: boolean): boolean;
  render(): void;
  undo(): void;
  redo(): void;
  addElement(type: 'div' | 'text' | 'button' | 'heading' | 'image' | 'hr', position?: AddPosition): void;
  duplicate(): void;
  listVariants(): string[];
  saveVariant(name: string): void;
  loadVariant(name: string): void;
  deleteVariant(name: string): void;
  /** 当前选中的元素（未选中返回 null） */
  getActive(): Element | null;
  /** 以编程方式选中一个元素（会同步显示面板与绿框） */
  select(el: Element): void;
  /** 面板当前是否真的可见（显示中且在视口内） */
  panelVisible(): boolean;
  /** 微调模式是否开启 */
  isOn(): boolean;
  /** 清除用户手动拖动的面板位置，恢复自动跟随 */
  resetPanelPos(): void;
}

declare const VisualEditKit: VisualEditKitAPI;
export default VisualEditKit;
