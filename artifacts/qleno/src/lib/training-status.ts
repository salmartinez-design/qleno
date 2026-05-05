import { useEffect, useState } from "react";
import { useAuthStore } from "@/lib/auth";

/**
 * Training-completion lookup. The LMS persists progress at
 *   localStorage[`qleno_lms_progress_${email || "anonymous"}`]
 * and sets `acknowledgedAt` (ISO string) when the user submits the
 * acknowledgment. We mirror that key here so the rest of the app can
 * surface a "Required" badge until completion.
 */

function readEmailFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const p = JSON.parse(atob(token.split(".")[1]));
    return p.email ?? null;
  } catch {
    return null;
  }
}

function isTrainingCompleted(email: string | null): boolean {
  try {
    const key = `qleno_lms_progress_${email || "anonymous"}`;
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!parsed?.acknowledgedAt;
  } catch {
    return false;
  }
}

/**
 * Returns true when the current user has NOT yet acknowledged the
 * training and should see a "Required" indicator.
 *
 * Polls every 5s in addition to listening for cross-tab storage
 * events — same-tab writes don't fire `storage`, so the LMS
 * page completing the flow needs the poll to be picked up.
 */
export function useTrainingRequired(): boolean {
  const token = useAuthStore(s => s.token);
  const [required, setRequired] = useState<boolean>(() =>
    !isTrainingCompleted(readEmailFromToken(token))
  );

  useEffect(() => {
    const email = readEmailFromToken(token);
    setRequired(!isTrainingCompleted(email));

    const id = setInterval(() => {
      setRequired(!isTrainingCompleted(email));
    }, 5000);

    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith("qleno_lms_progress_")) {
        setRequired(!isTrainingCompleted(email));
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      clearInterval(id);
      window.removeEventListener("storage", onStorage);
    };
  }, [token]);

  return required;
}
