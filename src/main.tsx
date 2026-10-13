import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";

// 容错：id 缺失时给出明确报错，而不是让 react-dom 抛
// "Target container is not a DOM element" 这种难以定位的异常
const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('找不到挂载节点 #root（index.html 可能被破坏）');
}
ReactDOM.createRoot(rootEl).render(<App />);

// 窗口默认隐藏（visible: false），等界面就绪后再显示，彻底避免 WebView2 启动白屏。
// 注意：不能用 requestAnimationFrame——隐藏窗口的 rAF 在 Chromium 中会被暂停；
// setTimeout 在隐藏窗口正常触发。150ms 足够 React 完成首帧绘制，此前的暗色背景
// （backgroundColor + index.html 内联样式）已覆盖底色，不会露出白色。
setTimeout(() => {
  getCurrentWindow()
    .show()
    .catch(() => {
      /* 极端情况下 IPC 失败：由 Rust 侧兜底强制显示 */
    });
}, 150);
