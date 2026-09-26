import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Oniblock',
  description: 'Uniswap v4 hook: directional regime fee with an attested k, scored in public and gated by calibration.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-3">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Oniblock
            </Link>
            <nav className="flex gap-5 text-sm text-ink-2">
              <Link href="/" className="hover:text-ink">
                Live demo
              </Link>
              <Link href="/models" className="hover:text-ink">
                Models
              </Link>
            </nav>
            <span className="ml-auto text-xs text-muted">LPs get paid back by informed flow · the model that sets k is scored in public</span>
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-6 py-5">{children}</main>
      </body>
    </html>
  );
}
