"use client";

import { useEffect, useState, useTransition } from "react";
import { RiLockLine, RiLockUnlockLine } from "@remixicon/react";
import { guardStateAction, lockAction, unlockAction, type GuardState } from "./guard.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

  // No key configured: the demo runs open and there is nothing to unlock, so
  // the control renders nothing rather than a field that would do nothing. Per-
  // action caps still apply, and those are surfaced where an amount is entered.
  if (!state || state.mode === "open") return null;

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
