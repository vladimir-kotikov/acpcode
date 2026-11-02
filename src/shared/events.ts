// VS Code-free stand-ins for `vscode.Disposable` / `vscode.EventEmitter` /
// `vscode.OutputChannel`, so the ACP client and the AHP host can also run in
// a plain Node process. VS Code's own types satisfy these structurally.

export interface Disposable {
  dispose(): void;
}

/** Where a component writes its log; a `vscode.OutputChannel` fits. */
export interface Output extends Disposable {
  append(text: string): void;
  appendLine(text: string): void;
}

export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    // Like vscode.EventEmitter: one throwing listener doesn't starve the rest.
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (err) {
        console.error(err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
