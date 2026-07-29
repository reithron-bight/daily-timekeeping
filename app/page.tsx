"use client";

import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "minute-row-state-v1";
const MAX_HISTORY = 10;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type TimerTarget =
  | { type: "entry"; entryId: string }
  | { type: "onClock" }
  | { type: "offClock" };

type ActiveTimer = TimerTarget & { startedAt: number };

type WorkEntry = {
  id: string;
  description: string;
  minutes: number;
  createdAt: number;
};

type CurrentSession = {
  sessionDate: string;
  startMinutes: number;
  entries: WorkEntry[];
  onClockMinutes: number;
  offClockMinutes: number;
  paidRemainderSeconds: number;
  offClockRemainderSeconds: number;
  active: ActiveTimer | null;
};

type Snapshot = {
  id: string;
  createdAt: number;
  session: CurrentSession;
  paidMinutes: number;
  projects: string;
  clipboardRow: string;
};

type AppState = {
  version: 1;
  current: CurrentSession;
  history: Snapshot[];
};

type EditorState =
  | { mode: "create"; description: string; duration: string }
  | {
      mode: "edit";
      target: TimerTarget;
      description: string;
      duration: string;
    };

type Confirmation =
  | { type: "newDay" }
  | { type: "deleteAll" }
  | { type: "restore"; snapshotId: string };

type GeneratedResult = { snapshot: Snapshot; copied: boolean };

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function makeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function freshSession(date = todayKey()): CurrentSession {
  return {
    sessionDate: date,
    startMinutes: 12 * 60,
    entries: [],
    onClockMinutes: 0,
    offClockMinutes: 0,
    paidRemainderSeconds: 0,
    offClockRemainderSeconds: 0,
    active: null,
  };
}

function initialState(): AppState {
  return { version: 1, current: freshSession(), history: [] };
}

function cloneSession(session: CurrentSession): CurrentSession {
  return {
    ...session,
    entries: session.entries.map((entry) => ({ ...entry })),
    active: session.active ? { ...session.active } : null,
  };
}

function sameTarget(active: ActiveTimer | null, target: TimerTarget) {
  if (!active || active.type !== target.type) return false;
  return (
    active.type !== "entry" ||
    active.entryId === (target as { entryId: string }).entryId
  );
}

function reconcileSession(session: CurrentSession, now: number): CurrentSession {
  if (!session.active) return session;
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - session.active.startedAt) / 1000),
  );
  if (elapsedSeconds === 0) return session;

  const active: ActiveTimer = {
    ...session.active,
    startedAt: session.active.startedAt + elapsedSeconds * 1000,
  };

  if (active.type === "offClock") {
    const seconds = session.offClockRemainderSeconds + elapsedSeconds;
    return {
      ...session,
      offClockMinutes: session.offClockMinutes + Math.floor(seconds / 60),
      offClockRemainderSeconds: seconds % 60,
      active,
    };
  }

  const seconds = session.paidRemainderSeconds + elapsedSeconds;
  const addedMinutes = Math.floor(seconds / 60);
  const next: CurrentSession = {
    ...session,
    paidRemainderSeconds: seconds % 60,
    active,
  };
  if (addedMinutes === 0) return next;
  if (active.type === "onClock") {
    return { ...next, onClockMinutes: next.onClockMinutes + addedMinutes };
  }
  return {
    ...next,
    entries: next.entries.map((entry) =>
      entry.id === active.entryId
        ? { ...entry, minutes: entry.minutes + addedMinutes }
        : entry,
    ),
  };
}

function paidMinutes(session: CurrentSession) {
  return (
    session.entries.reduce((total, entry) => total + entry.minutes, 0) +
    session.onClockMinutes
  );
}

function formatDuration(minutes: number) {
  const safeMinutes = Math.max(0, Math.floor(minutes));
  return `${Math.floor(safeMinutes / 60)}:${pad(safeMinutes % 60)}`;
}

function parseDuration(value: string) {
  const match = value.trim().match(/^(\d+):([0-5]?\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatClock(totalMinutes: number) {
  const normalized = ((Math.floor(totalMinutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  return `${hour24 % 12 || 12}:${pad(minute)} ${period}`;
}

function dateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function formatLongDate(key: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(dateFromKey(key));
}

function formatExcelDate(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return `${month}/${day}/${year}`;
}

function formatGeneratedAt(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatHistoryDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function decimalHours(minutes: number) {
  return String(Number((minutes / 60).toFixed(4)));
}

function minuteLabel(minutes: number) {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function projectsText(session: CurrentSession) {
  const parts = session.entries
    .filter((entry) => entry.minutes > 0)
    .map(
      (entry) =>
        `${entry.description.trim() || "No description"} (${minuteLabel(entry.minutes)})`,
    );
  if (session.onClockMinutes > 0) {
    parts.push(`On-Clock Break (${minuteLabel(session.onClockMinutes)})`);
  }
  return parts.join(" + ");
}

function clipboardCells(session: CurrentSession) {
  const total = paidMinutes(session);
  return [
    formatExcelDate(session.sessionDate),
    formatClock(session.startMinutes),
    `${session.onClockMinutes} min`,
    `${session.offClockMinutes} min`,
    formatClock(session.startMinutes + total),
    decimalHours(total),
    ...Array(8).fill(""),
    projectsText(session),
  ];
}

function clipboardRow(session: CurrentSession) {
  return clipboardCells(session).join("\t");
}

function createSnapshot(session: CurrentSession, createdAt: number): Snapshot {
  const stoppedSession = { ...cloneSession(session), active: null };
  return {
    id: makeId(),
    createdAt,
    session: stoppedSession,
    paidMinutes: paidMinutes(stoppedSession),
    projects: projectsText(stoppedSession),
    clipboardRow: clipboardRow(stoppedSession),
  };
}

function sessionHasActivity(session: CurrentSession) {
  return Boolean(
    session.active ||
      session.entries.length ||
      session.onClockMinutes ||
      session.offClockMinutes ||
      session.paidRemainderSeconds ||
      session.offClockRemainderSeconds,
  );
}

function targetMinutes(session: CurrentSession, target: TimerTarget) {
  if (target.type === "onClock") return session.onClockMinutes;
  if (target.type === "offClock") return session.offClockMinutes;
  return session.entries.find((entry) => entry.id === target.entryId)?.minutes ?? 0;
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a selected text field for stricter browsers.
    }
  }
  const source = document.createElement("textarea");
  source.value = text;
  source.setAttribute("readonly", "");
  source.style.position = "fixed";
  source.style.left = "-10000px";
  source.style.opacity = "0";
  document.body.appendChild(source);
  source.select();
  source.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  source.remove();
  return copied;
}

export default function Home() {
  const [state, setState] = useState<AppState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<"current" | "history">("current");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState("");
  const [generated, setGenerated] = useState<GeneratedResult | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [rolloverOpen, setRolloverOpen] = useState(false);
  const [rolloverDismissedFor, setRolloverDismissedFor] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [installPrompt, setInstallPrompt] =
    useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as AppState;
        if (
          parsed.version === 1 &&
          parsed.current &&
          Array.isArray(parsed.current.entries) &&
          Array.isArray(parsed.history)
        ) {
          setState({
            version: 1,
            current: reconcileSession(parsed.current, Date.now()),
            history: parsed.history.slice(0, MAX_HISTORY),
          });
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    } finally {
      setHydrated(true);
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(`${BASE_PATH}/sw.js`).catch(() => undefined);
    }

    const handleInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleInstall);
    return () => window.removeEventListener("beforeinstallprompt", handleInstall);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [hydrated, state]);

  useEffect(() => {
    if (!state.current.active) return;
    const timer = window.setInterval(() => {
      setState((previous) => ({
        ...previous,
        current: reconcileSession(previous.current, Date.now()),
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.current.active]);

  useEffect(() => {
    const reconcileVisible = () => {
      if (document.visibilityState === "visible") {
        setState((previous) => ({
          ...previous,
          current: reconcileSession(previous.current, Date.now()),
        }));
      }
    };
    document.addEventListener("visibilitychange", reconcileVisible);
    return () => document.removeEventListener("visibilitychange", reconcileVisible);
  }, []);

  useEffect(() => {
    if (
      hydrated &&
      state.current.sessionDate !== todayKey() &&
      rolloverDismissedFor !== state.current.sessionDate &&
      sessionHasActivity(state.current)
    ) {
      setRolloverOpen(true);
    }
  }, [hydrated, rolloverDismissedFor, state.current]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (generated) setGenerated(null);
      else if (editor) {
        setEditor(null);
        setEditorError("");
      } else if (confirmation) setConfirmation(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [confirmation, editor, generated]);

  const current = state.current;
  const totalPaid = paidMinutes(current);
  const startHour24 = Math.floor(current.startMinutes / 60);
  const startHour12 = startHour24 % 12 || 12;
  const startMinute = current.startMinutes % 60;
  const startPeriod = startHour24 >= 12 ? "PM" : "AM";
  const selectedSnapshot = useMemo(
    () =>
      state.history.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null,
    [selectedSnapshotId, state.history],
  );

  const updateStartTime = (
    hour: number,
    minute: number,
    period: "AM" | "PM",
  ) => {
    let hour24 = hour % 12;
    if (period === "PM") hour24 += 12;
    setState((previous) => ({
      ...previous,
      current: {
        ...reconcileSession(previous.current, Date.now()),
        startMinutes: hour24 * 60 + minute,
      },
    }));
  };

  const toggleTimer = (target: TimerTarget) => {
    const now = Date.now();
    setState((previous) => {
      const reconciled = reconcileSession(previous.current, now);
      return {
        ...previous,
        current: {
          ...reconciled,
          active: sameTarget(reconciled.active, target)
            ? null
            : { ...target, startedAt: now },
        },
      };
    });
  };

  const openNewEntry = () => {
    setEditorError("");
    setEditor({ mode: "create", description: "", duration: "0:00" });
  };

  const openEditor = (target: TimerTarget) => {
    const reconciled = reconcileSession(current, Date.now());
    setState((previous) => ({ ...previous, current: reconciled }));
    const entry =
      target.type === "entry"
        ? reconciled.entries.find((item) => item.id === target.entryId)
        : null;
    setEditorError("");
    setEditor({
      mode: "edit",
      target,
      description: entry?.description ?? "",
      duration: formatDuration(targetMinutes(reconciled, target)),
    });
  };

  const saveEditor = () => {
    if (!editor) return;
    const minutes = parseDuration(editor.duration);
    if (minutes === null) {
      setEditorError("Enter time as hours:minutes, such as 1:05.");
      return;
    }
    const now = Date.now();
    setState((previous) => {
      const reconciled = reconcileSession(previous.current, now);
      if (editor.mode === "create") {
        const entry: WorkEntry = {
          id: makeId(),
          description: editor.description.trim(),
          minutes,
          createdAt: now,
        };
        return {
          ...previous,
          current: {
            ...reconciled,
            entries: [...reconciled.entries, entry],
            active: { type: "entry", entryId: entry.id, startedAt: now },
          },
        };
      }
      const target = editor.target;
      if (target.type === "entry") {
        return {
          ...previous,
          current: {
            ...reconciled,
            entries: reconciled.entries.map((entry) =>
              entry.id === target.entryId
                ? {
                    ...entry,
                    description: editor.description.trim(),
                    minutes,
                  }
                : entry,
            ),
          },
        };
      }
      return {
        ...previous,
        current: {
          ...reconciled,
          ...(target.type === "onClock"
            ? { onClockMinutes: minutes }
            : { offClockMinutes: minutes }),
        },
      };
    });
    setEditor(null);
    setEditorError("");
  };

  const deleteEditedEntry = () => {
    if (!editor || editor.mode !== "edit" || editor.target.type !== "entry") return;
    const targetId = editor.target.entryId;
    setState((previous) => {
      const reconciled = reconcileSession(previous.current, Date.now());
      return {
        ...previous,
        current: {
          ...reconciled,
          entries: reconciled.entries.filter((entry) => entry.id !== targetId),
          active:
            reconciled.active?.type === "entry" &&
            reconciled.active.entryId === targetId
              ? null
              : reconciled.active,
        },
      };
    });
    setEditor(null);
  };

  const generateEntry = async () => {
    const now = Date.now();
    const stopped: CurrentSession = {
      ...reconcileSession(current, now),
      active: null,
    };
    const snapshot = createSnapshot(stopped, now);
    setState((previous) => ({
      ...previous,
      current: stopped,
      history: [snapshot, ...previous.history].slice(0, MAX_HISTORY),
    }));
    const copied = await copyToClipboard(snapshot.clipboardRow);
    setGenerated({ snapshot, copied });
    setSelectedSnapshotId(snapshot.id);
  };

  const copySnapshot = async (snapshot: Snapshot) => {
    const copied = await copyToClipboard(snapshot.clipboardRow);
    setNotice(
      copied ? "15 cells copied — ready for Excel." : "Clipboard access was blocked.",
    );
  };

  const handleConfirmation = () => {
    if (!confirmation) return;
    if (confirmation.type === "newDay") {
      setState((previous) => ({ ...previous, current: freshSession() }));
      setRolloverDismissedFor(null);
      setView("current");
    }
    if (confirmation.type === "deleteAll") {
      setState((previous) => ({ ...previous, history: [] }));
      setSelectedSnapshotId(null);
    }
    if (confirmation.type === "restore") {
      const snapshot = state.history.find(
        (item) => item.id === confirmation.snapshotId,
      );
      if (snapshot) {
        setState((previous) => ({
          ...previous,
          current: { ...cloneSession(snapshot.session), active: null },
        }));
        setRolloverDismissedFor(snapshot.session.sessionDate);
        setView("current");
        setNotice("Snapshot restored to Current Timekeeping.");
      }
    }
    setConfirmation(null);
  };

  const deleteSnapshot = (snapshotId: string) => {
    setState((previous) => ({
      ...previous,
      history: previous.history.filter((snapshot) => snapshot.id !== snapshotId),
    }));
    if (selectedSnapshotId === snapshotId) setSelectedSnapshotId(null);
  };

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setNotice("Daily Timekeeping installed.");
    setInstallPrompt(null);
  };

  const editorTargetIsWork =
    editor?.mode === "create" ||
    (editor?.mode === "edit" && editor.target.type === "entry");

  const confirmationCopy =
    confirmation?.type === "deleteAll"
      ? {
          title: "Delete all history?",
          body: "All saved snapshots will be permanently removed. Current Timekeeping will not change.",
          action: "Delete All History",
          destructive: true,
        }
      : confirmation?.type === "restore"
        ? {
            title: "Restore this snapshot?",
            body: "This replaces Current Timekeeping with the selected snapshot. Your history will remain available.",
            action: "Restore Snapshot",
            destructive: false,
          }
        : {
            title: "Start a new day?",
            body: "This clears Current Timekeeping and resets the start time to 12:00 PM. History snapshots will remain available.",
            action: "Start New Day",
            destructive: false,
          };

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="brand-bar">
          <a className="brand" href="#" aria-label="Daily Timekeeping home">
            <span className="brand-mark" aria-hidden="true">
              <span className="brand-clock">
                <span className="clock-hand clock-hand-hour" />
                <span className="clock-hand clock-hand-minute" />
                <span className="clock-pin" />
              </span>
            </span>
            <span>Daily Timekeeping</span>
          </a>
          <div className="brand-actions">
            {installPrompt ? (
              <button className="button button-quiet" type="button" onClick={installApp}>
                Install app
              </button>
            ) : null}
            <span className="save-status">
              {hydrated ? "Saved on this device" : "Loading…"}
            </span>
          </div>
        </header>

        <section className="workspace">
          <div className="page-header">
            <div>
              <p className="eyebrow">
                {current.sessionDate === todayKey() ? "Today" : "Timekeeping date"}
              </p>
              <h1>{formatLongDate(current.sessionDate)}</h1>
            </div>
            <nav className="view-tabs" aria-label="Timekeeping views">
              <button
                className={view === "current" ? "tab is-active" : "tab"}
                type="button"
                aria-pressed={view === "current"}
                onClick={() => setView("current")}
              >
                Current Timekeeping
              </button>
              <button
                className={view === "history" ? "tab is-active" : "tab"}
                type="button"
                aria-pressed={view === "history"}
                onClick={() => setView("history")}
              >
                History
                {state.history.length ? (
                  <span className="tab-count">{state.history.length}</span>
                ) : null}
              </button>
            </nav>
          </div>

          {view === "current" ? (
            <>
              <div className="time-toolbar">
                <fieldset className="time-picker">
                  <legend>Start time</legend>
                  <div className="time-parts">
                    <label>
                      <span className="sr-only">Hour</span>
                      <select
                        aria-label="Start hour"
                        value={startHour12}
                        onChange={(event) =>
                          updateStartTime(
                            Number(event.target.value),
                            startMinute,
                            startPeriod,
                          )
                        }
                      >
                        {Array.from({ length: 12 }, (_, index) => index + 1).map(
                          (hour) => (
                            <option key={hour} value={hour}>
                              {hour}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <span className="time-divider" aria-hidden="true">
                      :
                    </span>
                    <label>
                      <span className="sr-only">Minute</span>
                      <select
                        aria-label="Start minute"
                        value={startMinute}
                        onChange={(event) =>
                          updateStartTime(
                            startHour12,
                            Number(event.target.value),
                            startPeriod,
                          )
                        }
                      >
                        {Array.from({ length: 60 }, (_, minute) => minute).map(
                          (minute) => (
                            <option key={minute} value={minute}>
                              {pad(minute)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label>
                      <span className="sr-only">AM or PM</span>
                      <select
                        aria-label="Start period"
                        value={startPeriod}
                        onChange={(event) =>
                          updateStartTime(
                            startHour12,
                            startMinute,
                            event.target.value as "AM" | "PM",
                          )
                        }
                      >
                        <option>AM</option>
                        <option>PM</option>
                      </select>
                    </label>
                  </div>
                </fieldset>
                <button className="button button-primary" type="button" onClick={openNewEntry}>
                  <span aria-hidden="true">＋</span>
                  New Entry
                </button>
              </div>

              <section className="entry-section" aria-labelledby="work-entries-title">
                <div className="section-heading">
                  <h2 id="work-entries-title">Work entries</h2>
                  <span>{current.entries.length} total</span>
                </div>
                <div className="entry-list">
                  {current.entries.length === 0 ? (
                    <div className="empty-state">
                      <p>No work entries yet.</p>
                      <button className="text-button" type="button" onClick={openNewEntry}>
                        Start your first timer
                      </button>
                    </div>
                  ) : (
                    current.entries.map((entry) => {
                      const target: TimerTarget = {
                        type: "entry",
                        entryId: entry.id,
                      };
                      const isActive = sameTarget(current.active, target);
                      return (
                        <article
                          className={isActive ? "entry-row is-running" : "entry-row"}
                          key={entry.id}
                        >
                          <div className="entry-copy">
                            <h3>{entry.description || "No description"}</h3>
                            <span>{isActive ? "Running" : "Stopped"}</span>
                          </div>
                          <strong className="duration">
                            {formatDuration(entry.minutes)}
                          </strong>
                          <div className="row-actions">
                            <button
                              className={isActive ? "button button-stop" : "button"}
                              type="button"
                              onClick={() => toggleTimer(target)}
                            >
                              <span aria-hidden="true">{isActive ? "■" : "▶"}</span>
                              {isActive ? "Stop" : "Start"}
                            </button>
                            <button
                              className="button button-quiet"
                              type="button"
                              onClick={() => openEditor(target)}
                            >
                              Edit
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="entry-section" aria-labelledby="breaks-title">
                <div className="section-heading">
                  <h2 id="breaks-title">Breaks</h2>
                  <span>Tracked separately</span>
                </div>
                <div className="entry-list">
                  {(
                    [
                      {
                        target: { type: "onClock" } as TimerTarget,
                        title: "On-Clock Breaks",
                        detail: "Included in paid total and projects completed",
                        minutes: current.onClockMinutes,
                      },
                      {
                        target: { type: "offClock" } as TimerTarget,
                        title: "Off-Clock Breaks",
                        detail: "Recorded only in column D",
                        minutes: current.offClockMinutes,
                      },
                    ] as const
                  ).map((breakItem) => {
                    const isActive = sameTarget(current.active, breakItem.target);
                    return (
                      <article
                        className={isActive ? "entry-row is-running" : "entry-row"}
                        key={breakItem.title}
                      >
                        <div className="entry-copy">
                          <h3>{breakItem.title}</h3>
                          <span>{isActive ? "Running" : breakItem.detail}</span>
                        </div>
                        <strong className="duration">
                          {formatDuration(breakItem.minutes)}
                        </strong>
                        <div className="row-actions">
                          <button
                            className={isActive ? "button button-stop" : "button"}
                            type="button"
                            onClick={() => toggleTimer(breakItem.target)}
                          >
                            <span aria-hidden="true">{isActive ? "■" : "▶"}</span>
                            {isActive ? "Stop" : "Start"}
                          </button>
                          <button
                            className="button button-quiet"
                            type="button"
                            onClick={() => openEditor(breakItem.target)}
                          >
                            Edit
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="totals" aria-label="Running totals">
                <div>
                  <span>Paid total</span>
                  <strong>{formatDuration(totalPaid)}</strong>
                </div>
                <div>
                  <span>Calculated end</span>
                  <strong>{formatClock(current.startMinutes + totalPaid)}</strong>
                </div>
                <div>
                  <span>Off-clock</span>
                  <strong>{formatDuration(current.offClockMinutes)}</strong>
                </div>
              </section>

              <div className="page-actions">
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setConfirmation({ type: "newDay" })}
                >
                  Start New Day
                </button>
                <button
                  className="button button-primary button-large"
                  type="button"
                  onClick={generateEntry}
                >
                  Generate Time Sheet Entry
                </button>
              </div>
            </>
          ) : (
            <section className="history-layout" aria-labelledby="history-title">
              <div className="history-header">
                <div>
                  <h2 id="history-title">Generated snapshots</h2>
                  <p>The newest ten are saved on this device.</p>
                </div>
                {state.history.length ? (
                  <button
                    className="button button-danger-quiet"
                    type="button"
                    onClick={() => setConfirmation({ type: "deleteAll" })}
                  >
                    Delete All
                  </button>
                ) : null}
              </div>

              {state.history.length === 0 ? (
                <div className="history-empty">
                  <strong>No snapshots yet</strong>
                  <p>
                    Generate a time sheet entry and it will appear here without
                    interrupting Current Timekeeping.
                  </p>
                  <button className="button" type="button" onClick={() => setView("current")}>
                    Return to Current Timekeeping
                  </button>
                </div>
              ) : (
                <div className="history-grid">
                  <div className="snapshot-list" aria-label="Saved snapshots">
                    {state.history.map((snapshot) => (
                      <article
                        className={
                          snapshot.id === selectedSnapshotId
                            ? "snapshot-row is-selected"
                            : "snapshot-row"
                        }
                        key={snapshot.id}
                      >
                        <button
                          className="snapshot-select"
                          type="button"
                          onClick={() => setSelectedSnapshotId(snapshot.id)}
                        >
                          <strong>{formatHistoryDate(snapshot.createdAt)}</strong>
                          <span>
                            {formatDuration(snapshot.paidMinutes)} paid ·{" "}
                            {snapshot.session.entries.length}{" "}
                            {snapshot.session.entries.length === 1 ? "entry" : "entries"}
                          </span>
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`Delete snapshot from ${formatHistoryDate(snapshot.createdAt)}`}
                          onClick={() => deleteSnapshot(snapshot.id)}
                        >
                          ×
                        </button>
                      </article>
                    ))}
                  </div>

                  <div className="snapshot-detail">
                    {selectedSnapshot ? (
                      <>
                        <div className="snapshot-detail-head">
                          <div>
                            <p className="eyebrow">Snapshot</p>
                            <h3>{formatLongDate(selectedSnapshot.session.sessionDate)}</h3>
                            <span>
                              Generated at {formatGeneratedAt(selectedSnapshot.createdAt)}
                            </span>
                          </div>
                          <strong>{formatDuration(selectedSnapshot.paidMinutes)}</strong>
                        </div>
                        <dl className="snapshot-facts">
                          <div>
                            <dt>Start</dt>
                            <dd>{formatClock(selectedSnapshot.session.startMinutes)}</dd>
                          </div>
                          <div>
                            <dt>End</dt>
                            <dd>
                              {formatClock(
                                selectedSnapshot.session.startMinutes +
                                  selectedSnapshot.paidMinutes,
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Decimal hours</dt>
                            <dd>{decimalHours(selectedSnapshot.paidMinutes)}</dd>
                          </div>
                          <div>
                            <dt>Off-clock</dt>
                            <dd>{selectedSnapshot.session.offClockMinutes} min</dd>
                          </div>
                        </dl>
                        <div className="projects-preview">
                          <span>Projects completed · column O</span>
                          <p>{selectedSnapshot.projects || "No project text generated"}</p>
                        </div>
                        <div className="snapshot-actions">
                          <button
                            className="button"
                            type="button"
                            onClick={() =>
                              setConfirmation({
                                type: "restore",
                                snapshotId: selectedSnapshot.id,
                              })
                            }
                          >
                            Restore as Current
                          </button>
                          <button
                            className="button button-primary"
                            type="button"
                            onClick={() => copySnapshot(selectedSnapshot)}
                          >
                            Copy Again
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="detail-placeholder">
                        <strong>Select a snapshot</strong>
                        <p>Review, copy, or restore any saved time sheet entry.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </section>

        <footer className="app-footer">
          <span>Local-first · works offline</span>
          <span>No account or cloud time records</span>
        </footer>
      </div>

      {editor ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="entry-modal-title"
          >
            <div className="modal-head">
              <div>
                <p className="eyebrow">
                  {editor.mode === "create" ? "New timer" : "Time entry"}
                </p>
                <h2 id="entry-modal-title">
                  {editor.mode === "create"
                    ? "Create new entry"
                    : editor.target.type === "entry"
                      ? "Edit time entry"
                      : editor.target.type === "onClock"
                        ? "Edit on-clock breaks"
                        : "Edit off-clock breaks"}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close"
                onClick={() => {
                  setEditor(null);
                  setEditorError("");
                }}
              >
                ×
              </button>
            </div>

            {editor.mode === "create" ? (
              <p className="modal-note">
                Your current timer keeps running until you create this entry.
              </p>
            ) : null}

            {editorTargetIsWork ? (
              <label className="field">
                <span>
                  Description <small>(optional)</small>
                </span>
                <textarea
                  rows={3}
                  autoFocus={editor.mode === "create"}
                  placeholder="What are you working on?"
                  value={editor.description}
                  onChange={(event) =>
                    setEditor({ ...editor, description: event.target.value })
                  }
                />
              </label>
            ) : null}

            <label className="field">
              <span>Time</span>
              <input
                autoFocus={!editorTargetIsWork}
                inputMode="numeric"
                value={editor.duration}
                aria-describedby="duration-help"
                onChange={(event) => {
                  setEditor({ ...editor, duration: event.target.value });
                  setEditorError("");
                }}
              />
              <small id="duration-help">Hours:minutes</small>
            </label>
            {editorError ? <p className="field-error">{editorError}</p> : null}

            <div className="modal-actions">
              {editor.mode === "edit" && editor.target.type === "entry" ? (
                <button
                  className="button button-danger-quiet push-left"
                  type="button"
                  onClick={deleteEditedEntry}
                >
                  Delete
                </button>
              ) : null}
              <button
                className="button"
                type="button"
                onClick={() => {
                  setEditor(null);
                  setEditorError("");
                }}
              >
                Cancel
              </button>
              <button className="button button-primary" type="button" onClick={saveEditor}>
                {editor.mode === "create" ? "Create New Entry" : "Update Entry"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {generated ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal modal-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generated-title"
          >
            <div className="success-line">
              <span aria-hidden="true">✓</span>
              {generated.copied
                ? "15 cells copied — ready to paste into Excel"
                : "Entry generated — use Copy Again to allow clipboard access"}
            </div>
            <div className="modal-head">
              <div>
                <p className="eyebrow">Snapshot saved</p>
                <h2 id="generated-title">Time sheet entry generated</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close"
                onClick={() => setGenerated(null)}
              >
                ×
              </button>
            </div>
            <div className="excel-preview">
              {clipboardCells(generated.snapshot.session)
                .slice(0, 6)
                .map((value, index) => (
                  <div key={index}>
                    <span>{String.fromCharCode(65 + index)}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
            </div>
            <p className="blank-columns">Columns G–N are blank</p>
            <div className="column-o-preview">
              <span>O · Projects completed</span>
              <p>{generated.snapshot.projects || "No project text generated"}</p>
            </div>
            <div className="modal-actions">
              <button
                className="button"
                type="button"
                onClick={async () => {
                  const copied = await copyToClipboard(
                    generated.snapshot.clipboardRow,
                  );
                  setGenerated({ ...generated, copied });
                }}
              >
                Copy Again
              </button>
              <button
                className="button button-primary"
                type="button"
                onClick={() => setGenerated(null)}
              >
                Done
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {confirmation ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal modal-small"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirmation-title"
          >
            <h2 id="confirmation-title">{confirmationCopy.title}</h2>
            <p className="modal-note">{confirmationCopy.body}</p>
            <div className="modal-actions">
              <button
                className="button"
                type="button"
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className={
                  confirmationCopy.destructive
                    ? "button button-danger"
                    : "button button-primary"
                }
                type="button"
                onClick={handleConfirmation}
              >
                {confirmationCopy.action}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {rolloverOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal modal-small"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rollover-title"
          >
            <p className="eyebrow">A new calendar day has started</p>
            <h2 id="rollover-title">Continue or start today?</h2>
            <p className="modal-note">
              Current Timekeeping belongs to {formatLongDate(current.sessionDate)}.
            </p>
            <div className="modal-actions modal-actions-stack">
              <button
                className="button"
                type="button"
                onClick={() => {
                  setRolloverDismissedFor(current.sessionDate);
                  setRolloverOpen(false);
                }}
              >
                Continue Existing Session
              </button>
              <button
                className="button button-primary"
                type="button"
                onClick={() => {
                  setState((previous) => ({
                    ...previous,
                    current: freshSession(),
                  }));
                  setRolloverDismissedFor(null);
                  setRolloverOpen(false);
                }}
              >
                Start New Day
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}
    </main>
  );
}
