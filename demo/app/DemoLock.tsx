"use client";

import { useEffect, useState, useTransition } from "react";
import { RiLockLine, RiLockUnlockLine } from "@remixicon/react";
import { guardStateAction, lockAction, unlockAction, type GuardState } from "./guard.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToneBadge } from "./_ui";

/**
 * The header's lock control.
 *
 * Reads its state from the server rather than assuming: whether this deployment
 * is gated at all depends on `DEMO_WRITE_KEY`, which the browser must never see.
 * So the component asks "am I unlocked?" and is told yes or no — never why, and
 * never what the key is.
 *
 * It renders NOTHING in local development, where the gate is open by design.
 * A padlock on a door that is not locked teaches the wrong thing about the
 * deployment that matters.
 */
export default function DemoLock() {
  const [state, setState] = useState<GuardState | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    guardStateAction().then(setState);
  }, []);

  if (!state || state.mode === "open-dev") return null;

  // No key configured on a production build: nothing to enter, and the actions
  // are refused server-side regardless. Say so rather than offering a field
  // that cannot work.
  if (state.mode === "locked") {
    return (
      <ToneBadge tone="danger" className="gap-1">
        <RiLockLine className="size-3.5" />
        <span className="hidden sm:inline">No demo key set — writes disabled</span>
        <span className="sm:hidden">Writes off</span>
      </ToneBadge>
    );
  }

  if (state.unlocked) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => start(async () => {
          await lockAction();
          setState(await guardStateAction());
        })}
        title="Lock this browser again"
      >
        <RiLockUnlockLine className="size-4" />
        <span className="hidden sm:inline">Unlocked</span>
      </Button>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <RiLockLine className="size-4" />
        <span className="hidden sm:inline">Unlock</span>
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await unlockAction(secret);
          if (r.ok) {
            setSecret("");
            setOpen(false);
            setError(null);
            setState(await guardStateAction());
          } else {
            setError(r.error ?? "Rejected");
          }
        });
      }}
    >
      <Input
        // `type=password` so a shoulder and a screen recording see nothing, and
        // `autoComplete=off` so a shared browser does not remember the key for
        // the next person to sit down.
        type="password"
        autoComplete="off"
        value={secret}
        onChange={(e) => { setSecret(e.target.value); setError(null); }}
        placeholder="Demo key"
        aria-label="Demo key"
        aria-invalid={error != null}
        className="h-8 w-32 sm:w-40"
        autoFocus
      />
      <Button size="sm" type="submit" disabled={pending || secret.length === 0}>
        {pending ? "…" : "Unlock"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </form>
  );
}
