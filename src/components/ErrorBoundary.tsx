import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  /** 出错时的兜底 UI；默认提供一个可刷新按钮的占位屏 */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * 错误边界：捕获子树在渲染过程中的运行时错误，避免单个面板崩溃导致整个
 * 应用白屏 / 所有连接断开。终端、SFTP、资源监控各自独立包裹，互不影响。
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="error-boundary">
            <p>面板运行异常，请刷新页面恢复</p>
            <button
              className="btn"
              onClick={() => window.location.reload()}
            >
              刷新页面
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}