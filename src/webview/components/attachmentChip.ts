import { html } from "htm/preact";
import type { Attachment } from "../../shared/sessionViewProtocol.ts";

// `file://…` -> a plain fs path, the shape onOpenFile/openFile
// (sessionViewProvider.ts) expects — `vscode.Uri.file(path)` there, not a
// URI string.
export function filePathFromUri(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

const chipLabel = (attachment: Attachment): string => {
  if (!attachment.line) {
    return attachment.name;
  }
  const range =
    attachment.endLine && attachment.endLine > attachment.line
      ? `${attachment.line}-${attachment.endLine}`
      : attachment.line;
  return `${attachment.name}:${range}`;
};

interface AttachmentChipProps {
  attachment: Attachment;
  // Omitted for an attachment with no `uri` (pasted clipboard bytes) —
  // there's nothing an editor could open.
  onOpen?: (attachment: Attachment) => void;
  // Only passed in the composer's own chip row — a chip inside a sent
  // transcript message is read-only, nothing left to remove.
  onRemove?: (id: string) => void;
}

export const AttachmentChip = ({
  attachment,
  onOpen,
  onRemove,
}: AttachmentChipProps) => html`
  <span class="attachment-chip" title=${attachment.uri ?? attachment.name}>
    <span
      class="attachment-chip-label ${onOpen && attachment.uri ? "attachment-chip-openable" : ""}"
      onClick=${() => attachment.uri && onOpen?.(attachment)}
      >${chipLabel(attachment)}</span
    >
    ${
      onRemove
        ? html`<button
            type="button"
            class="attachment-chip-remove"
            aria-label="Remove attachment"
            onClick=${() => onRemove(attachment.id)}
          >
            ×
          </button>`
        : null
    }
  </span>
`;

export const AttachmentChipList = ({
  attachments,
  onOpen,
  onRemove,
}: {
  attachments: Attachment[];
  onOpen?: (attachment: Attachment) => void;
  onRemove?: (id: string) => void;
}) =>
  attachments.length === 0
    ? null
    : html`
        <div class="attachment-chips">
          ${attachments.map(
            attachment =>
              html`<${AttachmentChip}
                key=${attachment.id}
                attachment=${attachment}
                onOpen=${onOpen}
                onRemove=${onRemove}
              />`,
          )}
        </div>
      `;
