"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Monta el modal en document.body, lo centra en el viewport
 * y bloquea el scroll de la página mientras esté abierto.
 */
export default function ModalPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarGap = window.innerWidth - document.documentElement.clientWidth;

    document.body.classList.add("modal-open");
    document.body.style.overflow = "hidden";
    if (scrollbarGap > 0) {
      document.body.style.paddingRight = `${scrollbarGap}px`;
    }

    return () => {
      document.body.classList.remove("modal-open");
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
