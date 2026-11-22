"use client";

import { Button, Panel } from "@/components/ui/primitives";

export default function SectionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Panel className="mx-auto mt-10 max-w-lg p-6 text-center">
      <h1 className="text-lg font-semibold">This section failed to load</h1>
      <p className="mt-2 text-[13.5px] text-muted">{error.message || "An unexpected error occurred."}{error.digest ? ` (ref ${error.digest})` : ""}</p>
      <Button variant="primary" className="mt-4" onClick={reset}>Reload section</Button>
    </Panel>
  );
}
