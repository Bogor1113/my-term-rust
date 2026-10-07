import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  /** 提示文案（确认 / 说明） */
  message?: ReactNode;
  /** 是否显示文本输入框（prompt 模式） */
  input?: {
    label?: string;
    defaultValue?: string;
    placeholder?: string;
    /** 聚焦时全选已有内容（重命名场景方便直接覆盖） */
    selectAll?: boolean;
  };
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮红色（危险操作：删除等） */
  danger?: boolean;
  /** 确认中状态：禁用按钮与关闭，防止重复提交 */
  busy?: boolean;
  onClose: () => void;
  /** 点击确定时回调；prompt 模式传入输入框当前值 */
  onConfirm: (inputValue: string) => void;
}

/**
 * 应用内深色确认 / 输入弹窗：替换 window.confirm / window.prompt，
 * 保持与整体界面风格一致（复用 modal-backdrop / modal / field 等样式）。
 */
export default function Modal({
  title,
  message,
  input,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  busy,
  onClose,
  onConfirm,
}: ModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // prompt 模式自动聚焦；重命名等场景全选默认值
  useEffect(() => {
    if (input) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        if (input.selectAll) el.select();
      }
    }
  }, [input]);

  const submit = () => {
    if (busy) return;
    onConfirm(input ? (inputRef.current?.value ?? '') : '');
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-btn"
            onClick={() => !busy && onClose()}
            title="关闭"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          {message && <div className="confirm-message">{message}</div>}
          {input && (
            <div className="field">
              {input.label && <span>{input.label}</span>}
              <input
                ref={inputRef}
                defaultValue={input.defaultValue ?? ''}
                placeholder={input.placeholder}
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                  if (e.key === 'Escape' && !busy) onClose();
                }}
              />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={() => !busy && onClose()} disabled={busy}>
            {cancelText}
          </button>
          <button
            className={`btn ${danger ? 'danger-btn' : 'primary'}`}
            onClick={submit}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}