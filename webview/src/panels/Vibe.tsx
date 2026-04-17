// Vibe panel — the Claude↔user channel (spec §0: bond between man and
// machine). Renders the ordered list of active notes the daemon has
// received via `notes.post`. Each note is:
//
//   [kind-glyph] title
//               body
//               file:line  (if located)                [jump] [resolve]
//
// Interaction:
//   - click a row → `openFile` posted to the extension (jumps the editor)
//   - click `resolve` → RPC to `notes.resolve` via the extension bridge
//
// Visual language carries the note kind through colour and a compact
// glyph. Severity overrides the kind colour when a note ships one
// (a `concern` with severity: critical shows red even though `concern`
// is yellow by default).

import type { Note, NoteKind, Severity } from "../types";
import { vs } from "../vscode";

const KIND_GLYPH: Record<NoteKind, string> = {
  observation: "👁",
  intent: "🎯",
  question: "❓",
  concern: "⚠",
};

const KIND_LABEL: Record<NoteKind, string> = {
  observation: "observation",
  intent: "intent",
  question: "question",
  concern: "concern",
};

const KIND_BASE_CLASS: Record<NoteKind, string> = {
  observation: "note-observation",
  intent: "note-intent",
  question: "note-question",
  concern: "note-concern",
};

const SEVERITY_CLASS: Partial<Record<Severity, string>> = {
  critical: "note-critical",
  error: "note-error",
  warning: "note-warning",
};

export function Vibe({ notes }: { notes: Note[] }) {
  if (notes.length === 0) {
    return (
      <div className="vibe-empty">
        <p>No notes yet.</p>
        <p className="dim">
          Agents drop observations here while they work. The MCP server's
          <code>ive_post_note</code> tool sends them.
        </p>
      </div>
    );
  }
  return (
    <ol className="vibe-list" role="list" aria-label="Vibe feed">
      {notes.map((n) => (
        <VibeRow key={n.id} note={n} />
      ))}
    </ol>
  );
}

function VibeRow({ note }: { note: Note }) {
  const sevClass = note.severity ? SEVERITY_CLASS[note.severity] ?? "" : "";
  const openLocation = () => {
    if (note.location) {
      vs().postMessage({ type: "openFile", location: note.location });
    }
  };
  const resolve = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    vs().postMessage({ type: "resolveNote", id: note.id });
  };
  return (
    <li
      className={`vibe-row ${KIND_BASE_CLASS[note.kind]} ${sevClass}`}
      tabIndex={0}
      data-note-id={note.id}
      onClick={openLocation}
      onKeyDown={(e) => {
        if (e.key === "Enter") openLocation();
      }}
    >
      <div className="vibe-top">
        <span className="vibe-glyph" aria-hidden="true">
          {KIND_GLYPH[note.kind]}
        </span>
        <span className="vibe-kind">{KIND_LABEL[note.kind]}</span>
        <span className="vibe-author dim">{note.author}</span>
        <span className="vibe-spacer" />
        <button
          className="vibe-resolve"
          onClick={resolve}
          aria-label={`Resolve ${note.title}`}
        >
          resolve
        </button>
      </div>
      <div className="vibe-title">{note.title}</div>
      {note.body ? <div className="vibe-body">{note.body}</div> : null}
      {note.location ? (
        <div className="vibe-loc dim">
          {note.location.file}:{note.location.range.start[0] + 1}
        </div>
      ) : null}
    </li>
  );
}
