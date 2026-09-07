type WorkspaceEvent = {
  target?: WorkspaceElement;
  key?: string;
  preventDefault?: () => void;
};

type WorkspaceDocument = {
  activeElement: WorkspaceElement | null;
  evictHiddenFocus: boolean;
};
type WorkspaceListener = (event: WorkspaceEvent) => void;

class WorkspaceElement {
  readonly dataset: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, WorkspaceListener[]>();
  private hiddenValue = false;
  private inertValue = false;
  disabled = false;
  tabIndex = 0;
  textContent = "";
  className = "";
  parentElement: WorkspaceElement | null = null;

  constructor(
    readonly id: string,
    private readonly documentRoot: WorkspaceDocument,
  ) {}

  get hidden() {
    return this.hiddenValue;
  }

  set hidden(value: boolean) {
    this.hiddenValue = value;
    if (value) this.evictUnavailableFocus();
  }

  get inert() {
    return this.inertValue;
  }

  set inert(value: boolean) {
    this.inertValue = value;
    if (value) this.evictUnavailableFocus();
  }

  private evictUnavailableFocus() {
    if (!this.documentRoot.evictHiddenFocus) return;
    if (!this.contains(this.documentRoot.activeElement)) return;
    this.documentRoot.activeElement = null;
  }

  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, active = !this.classes.has(name)) => {
      if (active) this.classes.add(name);
      if (!active) this.classes.delete(name);
      return active;
    },
  };

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: WorkspaceListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, event: WorkspaceEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, ...event });
    }
  }

  focus() {
    this.documentRoot.activeElement = this;
  }

  closest(selector: string): WorkspaceElement | null {
    if (selector === `#${this.id}`) return this;
    if (this.classes.has(selector.slice(1))) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  contains(candidate: WorkspaceElement | null): boolean {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.contains(candidate.parentElement);
  }
}

export function isAvailableWorkspaceFocus(element: WorkspaceElement | null) {
  if (!element) return false;
  for (let ancestor: WorkspaceElement | null = element; ancestor; ) {
    if (ancestor.hidden) return false;
    if (ancestor.inert) return false;
    ancestor = ancestor.parentElement;
  }
  return !element.disabled;
}

export function createWorkspaceShellHarness(
  width = 1259,
  options: { matchMedia?: boolean; evictHiddenFocus?: boolean } = {},
) {
  const documentRoot: WorkspaceDocument = {
    activeElement: null,
    evictHiddenFocus: options.evictHiddenFocus === true,
  };
  const element = (id: string) => new WorkspaceElement(id, documentRoot);
  const operationsTabButtons = ["runtime", "logs", "health"].map((name) => {
    const button = element(`${name}TabButton`);
    button.dataset.tab = name;
    return button;
  });
  const operationsTabPages = ["runtime", "logs", "health"].map((name) =>
    element(`${name}Tab`),
  );
  const dom = {
    app: element("app"),
    homeWorkspacePanel: element("homeWorkspacePanel"),
    homeWorkspaceButton: element("homeWorkspaceButton"),
    composerInput: element("composerInput"),
    chatPanel: element("chatPanel"),
    sessionsPanel: element("sessionsPanel"),
    configWorkspacePanel: element("configWorkspacePanel"),
    schedulesWorkspacePanel: element("schedulesWorkspacePanel"),
    schedulesWorkspaceButton: element("schedulesWorkspaceButton"),
    closeSchedulesWorkspaceButton: element("closeSchedulesWorkspaceButton"),
    chatWorkspaceButton: element("chatWorkspaceButton"),
    configWorkspaceButton: element("configWorkspaceButton"),
    sessionsToggleButton: element("sessionsToggleButton"),
    closeSessionsButton: element("closeSessionsButton"),
    closeConfigWorkspaceButton: element("closeConfigWorkspaceButton"),
    newSessionButton: element("newSessionButton"),
    sessionSearchInput: element("sessionSearchInput"),
    refreshSessionsButton: element("refreshSessionsButton"),
    panelBackdrop: element("panelBackdrop"),
    toastRegion: element("toastRegion"),
    operationsTabButtons,
    operationsTabPages,
  };
  dom.sessionsPanel.classes.add("sessions-panel");
  dom.closeSessionsButton.parentElement = dom.sessionsPanel;
  dom.sessionSearchInput.parentElement = dom.sessionsPanel;
  dom.refreshSessionsButton.parentElement = dom.sessionsPanel;
  dom.closeConfigWorkspaceButton.parentElement = dom.configWorkspacePanel;
  dom.closeSchedulesWorkspaceButton.parentElement = dom.schedulesWorkspacePanel;
  for (const child of [...operationsTabButtons, ...operationsTabPages]) {
    child.parentElement = dom.configWorkspacePanel;
  }

  const frames: Array<() => void> = [];
  const mediaListeners = new Set<(event: { matches: boolean }) => void>();
  const mediaQueries: string[] = [];
  const media = {
    get matches() {
      return width >= 1260;
    },
    addEventListener(
      event: string,
      listener: (event: { matches: boolean }) => void,
    ) {
      if (event === "change") mediaListeners.add(listener);
    },
  };
  const viewport = {
    requestAnimationFrame(callback: () => void) {
      frames.push(callback);
      return frames.length;
    },
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
    ...(options.matchMedia === false
      ? {}
      : {
          matchMedia(query: string) {
            mediaQueries.push(query);
            return media;
          },
        }),
  };

  return {
    dom,
    documentRoot,
    mediaQueries,
    viewport,
    flushFrames() {
      for (const frame of frames.splice(0)) frame();
    },
    resize(nextWidth: number) {
      const previouslyWide = media.matches;
      width = nextWidth;
      if (previouslyWide === media.matches) return;
      for (const listener of mediaListeners) {
        listener({ matches: media.matches });
      }
    },
  };
}
