import { useState } from 'react';
import type { Toast, ToastTone } from '../types';

// useToasts manages the dashboard's transient toast notifications.
// Each toast auto-dismisses after 3 seconds. The hook returns the
// current list (so callers can render it) and an addToast helper.
export const useToasts = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (text: string, tone: ToastTone): void => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3000);
  };

  return { toasts, addToast };
};
