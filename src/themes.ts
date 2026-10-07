// ---------- 终端配色主题 ----------
// 每套主题包含 xterm 完整的 16 色 ANSI 调色板 + 前景/背景/光标。
// 选择结果持久化到 localStorage，并通过 window 事件实时广播给所有终端标签。
import type { ITheme } from 'xterm';

export interface TermThemeDef {
  id: string;
  name: string;
  theme: ITheme;
}

export const TERM_THEMES: TermThemeDef[] = [
  {
    id: 'ocean',
    name: '深蓝（默认）',
    theme: {
      // 背景与主界面 --bg (#0e1116) 统一，避免终端区与整体界面风格割裂
      background: '#0e1116',
      foreground: '#d6dae2',
      cursor: '#5b9cff',
      cursorAccent: '#0e1116',
      selectionBackground: 'rgba(91, 156, 255, 0.32)',
      black: '#20242c',
      red: '#f07178',
      green: '#8ccf7e',
      yellow: '#e5c07b',
      blue: '#6fa8f6',
      magenta: '#c792ea',
      cyan: '#56c8d8',
      white: '#d6dae2',
      brightBlack: '#5c6470',
      brightRed: '#ff8189',
      brightGreen: '#9ce08c',
      brightYellow: '#f2d08c',
      brightBlue: '#8ab8ff',
      brightMagenta: '#d5a8ff',
      brightCyan: '#6adbe8',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'windterm',
    name: 'WindTerm',
    theme: {
      background: '#1c1c1c',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#1c1c1c',
      selectionBackground: 'rgba(80, 80, 255, 0.4)',
      black: '#333333',
      red: '#c4265e',
      green: '#86b42b',
      yellow: '#d0a500',
      blue: '#3465a4',
      magenta: '#8c6bc8',
      cyan: '#56adbc',
      white: '#e3e3dd',
      brightBlack: '#666666',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#9e862f',
      brightBlue: '#819aff',
      brightMagenta: '#ae81ff',
      brightCyan: '#66d9ef',
      brightWhite: '#f8f8f2',
    },
  },
  {
    id: 'classic-green',
    name: '经典绿',
    theme: {
      background: '#000000',
      foreground: '#33ff33',
      cursor: '#33ff33',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(51, 255, 51, 0.25)',
      black: '#000000',
      red: '#ff0000',
      green: '#33ff33',
      yellow: '#ffff00',
      blue: '#0066ff',
      magenta: '#cc33ff',
      cyan: '#00ffff',
      white: '#cccccc',
      brightBlack: '#999999',
      brightRed: '#ff3333',
      brightGreen: '#66ff66',
      brightYellow: '#ffff66',
      brightBlue: '#3399ff',
      brightMagenta: '#ff66ff',
      brightCyan: '#66ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'light',
    name: '明亮',
    theme: {
      background: '#f5f6f7',
      foreground: '#333333',
      cursor: '#111111',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0, 120, 215, 0.25)',
      black: '#1e1e1e',
      red: '#c91b00',
      green: '#00a200',
      yellow: '#bbb400',
      blue: '#0451a5',
      magenta: '#a31db1',
      cyan: '#0598a6',
      white: '#c5c1b4',
      brightBlack: '#666666',
      brightRed: '#ff0000',
      brightGreen: '#00d800',
      brightYellow: '#d8d800',
      brightBlue: '#2b7dd6',
      brightMagenta: '#c241d8',
      brightCyan: '#00c8d8',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: 'rgba(147, 161, 161, 0.3)',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#93a1a1',
      brightYellow: '#839496',
      brightBlue: '#6c71c4',
      brightMagenta: '#d33682',
      brightCyan: '#2aa198',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: 'rgba(68, 71, 90, 0.6)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: 'rgba(235, 219, 178, 0.25)',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(216, 222, 233, 0.25)',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
];

const THEME_KEY = 'myterm.theme';

/** 主题广播事件名（App 选择后分发给所有已打开的终端） */
export const THEME_EVENT = 'myterm-theme';

export function getThemeById(id: string): TermThemeDef {
  return TERM_THEMES.find((t) => t.id === id) ?? TERM_THEMES[0];
}

/** 是否为浅色主题（背景亮度高于阈值）：用于联动整体 UI 外壳（侧边栏/标签栏/面板） */
export function isLightTheme(id: string): boolean {
  const t = getThemeById(id);
  if (!t) return false;
  const h = parseHex(t.theme.background ?? '#0e1116');
  if (!h) return false;
  return (0.299 * h.r + 0.587 * h.g + 0.114 * h.b) / 255 > 0.5;
}

/** 读取本地保存的主题 id（供 App 下拉框初始值使用） */
export function getSavedThemeId(): string {
  try {
    const id = localStorage.getItem(THEME_KEY);
    return id && TERM_THEMES.some((t) => t.id === id) ? id : TERM_THEMES[0].id;
  } catch {
    return TERM_THEMES[0].id;
  }
}

/** 读取本地保存的主题（供终端创建时使用） */
export function loadTermTheme(): TermThemeDef {
  return getThemeById(getSavedThemeId());
}

// ---------- 选区兑底色计算 ----------
// xterm 渲染选区时会把「带透明度的 selectionBackground 与 background 混合后的
// 不透明色」注入到 <style> 中。个别 WebView2 下注入失效时（与光标/字体同源），
// styles.css 的 :where() 兑底规则用 --term-selection-bg 变量兜底绘制选区，
// 该变量由 TerminalTab 在此函数的结果上设置，保证随主题切换同步。

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function parseSelectionColor(
  s: string | undefined,
): { r: number; g: number; b: number; a: number } | null {
  if (!s) return null;
  const hex = parseHex(s);
  if (hex) return { ...hex, a: 1 };
  const m = s.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i,
  );
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
}

/** 计算选区兑底的不透明背景色（rgb() 字符串）。
 *  公式与 xterm 一致：逐通道 round(alpha * selection + (1-alpha) * background)。
 *  解析失败时回退为深蓝主题的混合色。 */
export function computeSelectionOpaque(theme: ITheme): string {
  const bg = parseHex(theme.background ?? '#0e1116');
  const sel = parseSelectionColor(theme.selectionBackground);
  if (!bg || !sel) return 'rgb(36, 59, 94)';
  const r = Math.round(sel.a * sel.r + (1 - sel.a) * bg.r);
  const g = Math.round(sel.a * sel.g + (1 - sel.a) * bg.g);
  const b = Math.round(sel.a * sel.b + (1 - sel.a) * bg.b);
  return `rgb(${r}, ${g}, ${b})`;
}

/** 选择主题：持久化并广播给所有终端 */
export function applyTermTheme(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* 存储失败时忽略 */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: id }));
}
