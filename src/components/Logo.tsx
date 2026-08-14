export function Logo({ className = "", mark = true }: { className?: string; mark?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {mark && (
        <svg viewBox="0 0 36 36" className="h-8 w-8 shrink-0" aria-hidden>
          <rect width="36" height="36" rx="10" fill="#111113" />
          <path d="M7 25 L18 9 L29 25" fill="none" stroke="#E8A317" strokeWidth="2.4" strokeLinejoin="round" />
          <path d="M12.5 25 L18 16.5 L23.5 25" fill="none" stroke="#F4EDE1" strokeWidth="1.6" />
        </svg>
      )}
      <div className="leading-none">
        <div className="font-display text-[17px] tracking-[0.14em] text-cream">RETROFLEX</div>
        <div className="mt-0.5 text-[9px] tracking-[0.28em] text-amber/80">REAR BEACON OS</div>
      </div>
    </div>
  );
}

export function ChevronMark({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" className={className} aria-hidden>
      <path d="M6 26 L18 8 L30 26" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M12 26 L18 16 L24 26" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
    </svg>
  );
}
