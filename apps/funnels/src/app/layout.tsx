import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'A&M',
  // Individual funnel pages set their own metadata from the published spec.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never lock zoom — pinch-to-zoom is an accessibility requirement, and the
  // iOS focus-zoom problem is solved with a 16px font size instead.
  maximumScale: 5,
  userScalable: true,
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
