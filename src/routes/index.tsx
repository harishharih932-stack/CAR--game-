import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [Game, setGame] = useState<React.ComponentType | null>(null);
  useEffect(() => {
    import("@/components/NightDriveGame").then((m) => setGame(() => m.default));
  }, []);
  if (!Game) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white/70 font-mono">
        Loading Night Drive…
      </div>
    );
  }
  return (
    <main>
      <h1 className="sr-only">Night Drive 3D — gesture-controlled racing</h1>
      <Game />
    </main>
  );
}
