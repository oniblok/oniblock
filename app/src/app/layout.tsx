import type { Metadata } from 'next';
import { Barlow_Condensed, Roboto_Mono } from 'next/font/google';
import './globals.css';

// UniPerp look: Roboto Mono for all UI text and numbers, a bold condensed grotesk for the wordmark / titles.
const mono = Roboto_Mono({ subsets: ['latin'], variable: '--font-mono-ui' });
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display-ui' });

export const metadata: Metadata = {
  title: 'Oniblock',
  description: 'Uniswap v4 hook: informed arbitrage pays LPs back, judged every block by an attested AI score.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
