export type ToastMood = 'celebrate' | 'think' | 'wave' | 'sad' | 'warn';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
  duration?: number;
  mood?: ToastMood;
}

type ToastInput = Omit<ToastMessage, 'id'>;
let addToast: ((toast: ToastInput) => void) | null = null;

export function registerToastHandler(handler: ((toast: ToastInput) => void) | null) {
  addToast = handler;
}

export function toast(message: ToastInput) {
  addToast?.(message);
}
