"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { ToastMessage } from "@/types/toast";

interface ToastContextType {
  toasts: ToastMessage[];
  addToast: (toast: Omit<ToastMessage, "id">) => string;
  removeToast: (id: string) => void;
  /** Unified contract: pending -> success/error via correlationId, prevents duplicate pending toasts */
  addToastWithCorrelation: (toast: Omit<ToastMessage, "id"> & { correlationId?: string }) => string;
  updateToast: (correlationId: string, patch: Partial<Omit<ToastMessage, "id">>) => void;
  dismissByCorrelation: (correlationId: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

let toastIdCounter = 0;
// Map correlationId -> toast id for deduplication and lifecycle
const correlationMap = new Map<string, string>();

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: Omit<ToastMessage, "id">) => {
    const id = `toast-${++toastIdCounter}-${Date.now()}`;
    const duration = toast.duration ?? 5000;
    setToasts((prev) => [...prev, { ...toast, duration, id }].slice(-5));
    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const addToastWithCorrelation = useCallback((toast: Omit<ToastMessage, "id"> & { correlationId?: string }) => {
    const correlationId = toast.correlationId;
    if (correlationId) {
      const existingId = correlationMap.get(correlationId);
      if (existingId) {
        // Deduplicate: update existing pending toast instead of spamming
        setToasts((prev) => prev.map((t) => (t.id === existingId ? { ...t, ...toast } : t)));
        return existingId;
      }
      const id = `toast-${++toastIdCounter}-${Date.now()}`;
      const duration = toast.duration ?? 0; // pending toasts are sticky until resolved
      const entry = { ...toast, duration, id } as ToastMessage;
      correlationMap.set(correlationId, id);
      setToasts((prev) => [...prev, entry].slice(-5));
      return id;
    }
    return addToast(toast);
  }, [addToast]);

  const updateToast = useCallback((correlationId: string, patch: Partial<Omit<ToastMessage, "id">>) => {
    const id = correlationMap.get(correlationId);
    if (!id) {
      // No pending toast, create one
      addToastWithCorrelation({ ...patch, type: patch.type ?? "info", message: patch.message ?? "", correlationId });
      return;
    }
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch, duration: patch.duration ?? 5000 } : t)));
  }, [addToastWithCorrelation]);

  const dismissByCorrelation = useCallback((correlationId: string) => {
    const id = correlationMap.get(correlationId);
    if (id) {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      correlationMap.delete(correlationId);
    }
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, addToastWithCorrelation, updateToast, dismissByCorrelation }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function useOptionalToast() {
  return useContext(ToastContext);
}

/**
 * Toast inventory — unified contract (reviewed for consistency)
 * success/error/pending all use correlationId so that:
 * - pending toast is shown while mutation is in-flight
 * - success/error update the same toast (no duplicate stack)
 * - rapid triple-click dedup prevents triple toasts (actionDedup window)
 */
export const TOAST_CONTRACT = {
  pending: (msg: string, correlationId: string) => ({ type: "info" as const, message: msg, title: "In progress", correlationId, duration: 0 }),
  success: (msg: string, correlationId: string) => ({ type: "success" as const, message: msg, title: "Success", correlationId, duration: 5000 }),
  error: (msg: string, correlationId: string) => ({ type: "error" as const, message: msg, title: "Error", correlationId, duration: 6000 }),
};
