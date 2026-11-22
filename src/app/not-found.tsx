import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <p className="text-6xl font-semibold tracking-[-0.04em] text-line">404</p>
        <h1 className="mt-2 text-xl font-semibold">This page doesn&apos;t exist</h1>
        <p className="mt-1 text-sm text-muted">Check the address, or head back to your dashboard.</p>
        <Link href="/overview" className="mt-4 inline-block rounded-md bg-violet px-4 py-2 text-sm font-medium text-white">Go to Overview</Link>
      </div>
    </div>
  );
}
