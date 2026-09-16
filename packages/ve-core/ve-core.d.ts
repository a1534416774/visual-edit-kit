// Type declarations for visual-edit-kit ve-core (UMD / CommonJS).
// Usage: `import { VisualEditKit } from 'visual-edit-kit/ve-core'` or via <script> (window.VisualEditKit)

export type ChangeKind = 'style' | 'text' | 'hide' | 'move' | 'delete' | 'token';
export type Feature = 'text' | 'color' | 'hide' | 'move' | 'token' | 'delete';
export type PickMode = 'click' | 'hover';

export interface Change {
  id: string;
  path: string;
  prop: string;
  value: string | number;
  kind: ChangeKind;
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
  save(): Promise<boolean>;
  reset(): void;
  render(): void;
}

declare const VisualEditKit: VisualEditKitAPI;
export default VisualEditKit;
