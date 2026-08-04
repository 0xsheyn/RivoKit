"use server";

import { guardMode, isUnlocked, lock, unlock, type GuardMode } from "../lib/guard.server.ts";

export type GuardState = {
  mode: GuardMode;
  unlocked: boolean;
};

/** What the UI needs to decide whether to show a lock, a key field, or nothing. */
export async function guardStateAction(): Promise<GuardState> {
  return { mode: guardMode(), unlocked: await isUnlocked() };
}

/**
 * Exchange the demo key for the unlock cookie.
 *
 * One failure message for every reason it can fail — wrong key, no key
 * configured, production with nothing set. Telling a caller *which* of those
 * happened tells them whether they are guessing against a real secret, and this
 * endpoint is as reachable as the ones it protects.
 */
export async function unlockAction(secret: string): Promise<{ ok: boolean; error?: string }> {
  if (await unlock(secret)) return { ok: true };
  return { ok: false, error: "That key was not accepted." };
}

export async function lockAction(): Promise<void> {
  await lock();
}
