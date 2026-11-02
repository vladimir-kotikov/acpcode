// Answers AHP `completions` for the message input: `/` for the agent's ACP
// commands, `@` / `#` for files in the session's working directory. The
// shapes follow what VS Code's own agent hosts return, which its chat input
// renders (command `_meta`, `document` resources).
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
  MessageAttachmentKind,
  type CompletionItem,
} from "@microsoft/agent-host-protocol";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const TRIGGER_CHARACTERS = ["/", "@", "#"];
const MAX_FILE_RESULTS = 50;
const FILE_LIST_TTL_MS = 30_000;

interface Token {
  typed: string;
  rangeStart: number;
  rangeEnd: number;
}

const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/** A `/command` being typed as the first word of the input. */
export function slashToken(text: string, offset: number): Token | undefined {
  let start = 0;
  while (start < offset && isSpace(text[start])) {
    start++;
  }
  if (text[start] !== "/") {
    return undefined;
  }
  for (let i = start + 1; i < offset; i++) {
    if (isSpace(text[i])) {
      return undefined;
    }
  }
  return {
    typed: text.slice(start + 1, offset),
    rangeStart: start,
    rangeEnd: offset,
  };
}

/** An `@file` / `#file` mention being typed at the cursor. */
export function mentionToken(
  text: string,
  offset: number,
): (Token & { trigger: string }) | undefined {
  for (let i = offset - 1; i >= 0; i--) {
    if (isSpace(text[i])) {
      return undefined;
    }
    if (text[i] === "@" || text[i] === "#") {
      return i === 0 || isSpace(text[i - 1])
        ? {
            trigger: text[i],
            typed: text.slice(i + 1, offset),
            rangeStart: i,
            rangeEnd: offset,
          }
        : undefined;
    }
  }
  return undefined;
}

export function commandItems(
  commands: AvailableCommand[],
  token: Token,
): CompletionItem[] {
  const typed = token.typed.toLowerCase();
  return commands
    .filter(command => command.name.toLowerCase().startsWith(typed))
    .map(command => ({
      insertText: `/${command.name} `,
      rangeStart: token.rangeStart,
      rangeEnd: token.rangeEnd,
      attachment: {
        type: MessageAttachmentKind.Simple,
        label: `/${command.name}`,
        // VS Code's chat input reads these keys for a command's description
        // and argument placeholder.
        _meta: {
          command: command.name,
          description: command.description,
          ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
        },
      },
    }));
}

/** Best matches first: basename prefix, then basename, then path. */
export function fileItems(
  root: string,
  files: string[],
  token: Token & { trigger: string },
): CompletionItem[] {
  const typed = token.typed.toLowerCase();
  const rank = (file: string): number => {
    const lower = file.toLowerCase();
    const base = path.basename(lower);
    if (base.startsWith(typed)) {
      return 0;
    }
    if (base.includes(typed)) {
      return 1;
    }
    return lower.includes(typed) ? 2 : -1;
  };
  return files
    .map(file => ({ file, rank: rank(file) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.file.length - b.file.length)
    .slice(0, MAX_FILE_RESULTS)
    .map(({ file }) => ({
      insertText: token.trigger + path.basename(file),
      rangeStart: token.rangeStart,
      rangeEnd: token.rangeEnd,
      attachment: {
        type: MessageAttachmentKind.Resource,
        uri: pathToFileURL(path.join(root, file)).href,
        label: file,
        displayKind: "document",
      },
    }));
}

const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();

/** The folder's files (tracked plus untracked, minus ignored), cached
 *  briefly since the client asks on every keystroke. */
export function listFiles(root: string): Promise<string[]> {
  const cached = fileLists.get(root);
  if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) {
    return cached.files;
  }
  // ponytail: git only; folders that aren't repositories get no file
  // completions. Walk the tree (honouring .gitignore) if that matters.
  const files = new Promise<string[]>(resolve =>
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : stdout.split("\n").filter(Boolean)),
    ),
  );
  fileLists.set(root, { at: Date.now(), files });
  return files;
}
