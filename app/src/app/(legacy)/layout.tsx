import Link from 'next/link';

/** Legacy pages (old dashboard with dev controls, models, full receipts) keep the old header. */
export default function LegacyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-3">
          <Link href="/" className="font-display text-xl uppercase leading-none">
            Oniblock
          </Link>
          <nav className="flex gap-5 text-sm text-ink-2">
            <Link href="/" className="hover:text-ink">
              Live
            </Link>
            <Link href="/classic" className="hover:text-ink">
              Classic dashboard
            </Link>
            <Link href="/models" className="hover:text-ink">
              Models
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-5">{children}</main>
    </>
  );
}
