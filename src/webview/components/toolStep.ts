import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { html } from "htm/preact";
import { match } from "ts-pattern";
import { buildDiffText } from "../diffText.ts";
import type { PendingPermission, ToolItem } from "../state.ts";
import { textOf } from "../state.ts";
import { CollapsibleStep } from "./collapsibleStep.ts";
import { PreBlock } from "./preBlock.ts";
import { StaticStep } from "./staticStep.ts";

// Shown as a fixed prefix on every tool-call step regardless of what title
// text the agent sends — some agents (e.g. web search) replace their title
// with just the query once known, dropping the tool name entirely otherwise.
const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch Mode",
  other: "Tool",
};

// Some agents already fold the kind word into the title (Claude's Edit/Read
// calls are titled "Edit package.json"/"Read src/foo.ts"); others don't
// (e.g. web search titled with just the query). The kind chip always shows
// — strip a matching leading word from the title instead of ever
// suppressing the chip, so the same word doesn't render two different ways
// (muted chip vs plain title text) depending on which agent/tool happened
// to bake it into the title.
function stripOwnKindLabel(kind: ToolKind, title: string): string {
  const prefix = `${TOOL_KIND_LABELS[kind]} `;
  return title.toLowerCase().startsWith(prefix.toLowerCase())
    ? title.slice(prefix.length)
    : title;
}

// Filename-only, optionally with a line suffix — full path lives in a hover
// tooltip at each call site instead.
function fileLinkLabel(location: { path: string; line?: number }): string {
  const fileName = location.path.split(/[\\/]/).pop() ?? location.path;
  return location.line ? `${fileName}:${location.line}` : fileName;
}

// Shell/execute output routinely arrives already wrapped by the agent in a
// markdown fence (e.g. ```console ... ```), formatted for a markdown-rendering
// client. We render tool content as plain text on purpose (raw output can
// contain its own literal markdown-looking characters that shouldn't be
// reinterpreted), so an outer fence just shows up as literal backticks
// instead of being stripped the way a markdown renderer would. PreBlock's
// styling already conveys "this is code" — unwrap a well-formed wrapping
// fence rather than displaying its markers.
function stripCodeFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return match ? match[1] : text;
}

const ToolCallContentView = ({ content }: { content: ToolCallContent[] }) =>
  content && content.length > 0
    ? content.map((item, index) =>
        match(item)
          .with(
            { type: "content" },
            item =>
              html`<${PreBlock}
                key=${index}
                content=${stripCodeFence(textOf(item.content))}
              />`,
          )
          .with(
            { type: "diff" },
            item =>
              html`<${PreBlock}
                key=${index}
                content=${buildDiffText(item.oldText ?? "", item.newText)}
                syntaxLanguage="diff"
              />`,
          )
          .otherwise(
            () =>
              html`<div class="step-content-other" key=${index}>
                [terminal output]
              </div>`,
          ),
      )
    : null;

// Rendered inside a tool step's body, right below its diff/content, instead
// of as a separate step elsewhere — the whole point is the user can see the
// actual change next to the buttons approving it. Only ever mounted while
// still unresolved — see ToolStep's `pendingApproval` gate — so there's no
// resolved/disabled state to render here anymore; once answered, the chosen
// option's name takes over the header's status slot instead (see
// `statusText` below).
function PendingPermissionView({
  pendingPermission,
  onRespond,
}: {
  pendingPermission: PendingPermission;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  return html`
    <div class="permission-card">
      <div class="permission-buttons">
        ${pendingPermission.options.map(
          option => html`
            <button
              key=${option.optionId}
              class="btn-secondary permission-${option.kind}"
              onClick=${() => onRespond(pendingPermission.requestId, option.optionId)}
            >
              ${option.name}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

interface ToolStepProps {
  item: ToolItem;
  onRespond: (requestId: string, optionId: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}

/** The one component for rendering a tool call — a `CollapsibleStep` for
 *  anything with detail to show, or a `StaticStep` for a completed read
 *  with a known location, whose title doubles as an "open the file" link
 *  and has nothing left to disclose. Which one, and what header/body each
 *  gets, is decided here from `item.kind`/`.location`/`.pendingPermission`
 *  — the two step primitives themselves stay protocol-agnostic. */
export function ToolStep({ item, onRespond, onOpenFile }: ToolStepProps) {
  // Collapsed by default, always — except a pending approval, which needs to
  // actually be visible (not hidden behind a step the user has to think to
  // expand) until it's resolved, at which point it collapses like any other.
  const pendingApproval =
    item.pendingPermission?.resolvedOptionId === undefined &&
    !!item.pendingPermission;
  // Once a permission request is resolved to a known option, that option's
  // own label (e.g. "Reject", "Always Allow") replaces the tool's own status
  // text — more useful than whatever generic status the tool call itself
  // carries (which a rejection may leave stuck at "pending"/"in_progress"
  // forever, since the tool never actually ran). `resolvedOptionId: null`
  // (resolved without knowing which option — see PendingPermission's own
  // doc comment) has no option to name, so status text is left alone.
  const resolvedOption = item.pendingPermission?.resolvedOptionId
    ? item.pendingPermission.options.find(
        option => option.optionId === item.pendingPermission?.resolvedOptionId,
      )
    : undefined;
  const statusText = resolvedOption?.name ?? item.status;
  const rejected = resolvedOption?.kind.startsWith("reject") ?? false;

  const location = item.location;
  // A completed read with a known location has nothing left to approve or
  // disclose — it renders as StaticStep, its title doubling as the file
  // link, instead of a CollapsibleStep whose only content would be that
  // same link again. Still falls through to CollapsibleStep while approval
  // is pending, so PendingPermissionView has somewhere to render its
  // buttons.
  const isFileLink = item.kind === "read" && !!location && !pendingApproval;

  const titleNode =
    isFileLink && location
      ? html`<a
          href="#"
          class="step-title step-title-link"
          title=${location.path}
          onClick=${(event: MouseEvent) => {
            event.preventDefault();
            onOpenFile(location.path, location.line);
          }}
          >${fileLinkLabel(location)}</a
        >`
      : html`<span class="step-title"
          >${stripOwnKindLabel(item.kind, item.title)}</span
        >`;

  const header = html`
    <span class="step-kind">${TOOL_KIND_LABELS[item.kind]}</span>
    ${titleNode}
    <span class="step-status ${rejected ? "step-status-rejected" : ""}"
      >${statusText}</span
    >
  `;

  if (isFileLink) {
    return html`<${StaticStep} header=${header} />`;
  }

  return html`<${CollapsibleStep}
    defaultOpen=${pendingApproval}
    header=${header}
  >
    <div class="step-body">
      ${item.kind === "execute" ? html`<${PreBlock} content=${item.title} copy />` : null}
      ${
        item.kind === "read" && location
          ? html`<a
              href="#"
              class="step-file-link"
              title=${location.path}
              onClick=${(event: MouseEvent) => {
                event.preventDefault();
                onOpenFile(location.path, location.line);
              }}
              >${fileLinkLabel(location)}</a
            >`
          : html`<${ToolCallContentView} content=${item.content} />`
      }
      ${
        pendingApproval
          ? html`<${PendingPermissionView}
              pendingPermission=${item.pendingPermission}
              onRespond=${onRespond}
            />`
          : null
      }
    </div>
  <//>`;
}
