import { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Part, Session } from "@opencode-ai/sdk/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  abortSession,
  createConnection,
  createSession,
  deleteSession,
  findRecentSuccessfulModel,
  listAgents,
  listMessages,
  listModels,
  listRecentProjectDirectories,
  listSessionStatuses,
  listSessions,
  renameSession,
  sendPrompt,
  type AgentOption,
  type ModelOption,
  type OpenCodeConnection,
  type PromptAttachment,
  type ThreadMessage,
} from "./opencode";

type ConnectionState = "connecting" | "connected" | "error";
type ThemeMode = "system" | "light" | "dark";
type GroupMode = "date" | "project";

const DEFAULT_URL = "http://127.0.0.1:4096";
const PINNED_SESSIONS_KEY = "agent-center-pinned-sessions";
const THEME_KEY = "agent-center-theme";
const GROUP_MODE_KEY = "agent-center-group-mode";
const READ_SESSIONS_KEY = "agent-center-read-sessions";
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function loadThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

function resolveTheme(mode: ThemeMode) {
  return mode === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : mode;
}

function themeIcon(mode: ThemeMode) {
  if (mode === "light") return "bi-sun";
  if (mode === "dark") return "bi-moon-stars";
  return "bi-circle-half";
}

function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "system") return resolveTheme(mode) === "dark" ? "light" : "dark";
  if (mode === "light") return "dark";
  return "system";
}

function loadPinnedSessionIDs() {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_SESSIONS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function loadGroupMode(): GroupMode {
  return localStorage.getItem(GROUP_MODE_KEY) === "project" ? "project" : "date";
}

function loadReadSessionUpdates(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(READ_SESSIONS_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function timeLabel(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function dayGroup(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startToday - startDate) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function subagentTitle(title: string) {
  return title.replace(/\s*\(@[^)]+\s+subagent\)\s*$/i, "").trim() || "Subagent";
}

function subagentName(title: string) {
  return title.match(/\(@([^\s)]+)\s+subagent\)/i)?.[1] || "subagent";
}

function displayAgentName(name: string) {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fileSizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAttachment(file: File): Promise<PromptAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve({
      id: crypto.randomUUID(),
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      dataUrl: String(reader.result),
    });
    reader.readAsDataURL(file);
  });
}

function textFromParts(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function messageListRevision(messages: ThreadMessage[]) {
  const last = messages[messages.length - 1];
  return `${messages.length}:${last?.id || ""}:${last?.completed || ""}:${last?.provider || ""}:${last?.model || ""}:${last?.error || ""}:${last ? JSON.stringify(last.parts) : ""}`;
}

type ToolPart = Extract<Part, { type: "tool" }>;
type TextPart = Extract<Part, { type: "text" }>;
type ReasoningPart = Extract<Part, { type: "reasoning" }>;
type FilePart = Extract<Part, { type: "file" }>;
type AssistantBlock =
  | { type: "reasoning"; parts: ReasoningPart[] }
  | { type: "tools"; parts: ToolPart[] }
  | { type: "files"; parts: FilePart[] }
  | { type: "text"; parts: TextPart[] };
type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TodoPriority = "high" | "medium" | "low";
type AgentTodo = { content: string; status: TodoStatus; priority: TodoPriority };

const todoStatuses = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);
const todoPriorities = new Set<TodoPriority>(["high", "medium", "low"]);

function parseTodos(value: unknown): AgentTodo[] | null {
  if (!Array.isArray(value)) return null;
  const todos: AgentTodo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.content !== "string" || !todoStatuses.has(record.status as TodoStatus)) return null;
    todos.push({
      content: record.content,
      status: record.status as TodoStatus,
      priority: todoPriorities.has(record.priority as TodoPriority) ? record.priority as TodoPriority : "medium",
    });
  }
  return todos;
}

function latestTodos(messages: ThreadMessage[]) {
  let latest: AgentTodo[] = [];
  messages.forEach((message) => {
    message.parts.forEach((part) => {
      if (part.type !== "tool" || part.tool.toLowerCase() !== "todowrite") return;
      const input = part.state.input as { todos?: unknown };
      let todos = parseTodos(input?.todos);
      if (!todos && "output" in part.state && typeof part.state.output === "string") {
        try {
          const output = JSON.parse(part.state.output) as { todos?: unknown } | unknown[];
          todos = parseTodos(Array.isArray(output) ? output : output.todos);
        } catch {
          // A running tool can have partial output. Keep the previous valid todo revision.
        }
      }
      if (todos) latest = todos;
    });
  });
  return latest;
}

const todoPresentation: Record<TodoStatus, { label: string; icon: string }> = {
  pending: { label: "Pending", icon: "bi-circle" },
  in_progress: { label: "In progress", icon: "bi-arrow-repeat" },
  completed: { label: "Completed", icon: "bi-check2" },
  cancelled: { label: "Cancelled", icon: "bi-dash" },
};

function TodoPanel({ todos }: { todos: AgentTodo[] }) {
  const [open, setOpen] = useState(true);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const progress = todos.length ? Math.round((completed / todos.length) * 100) : 0;

  return (
    <details
      className="todo-panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="todo-heading"><i className="bi bi-list-check" aria-hidden="true" /> Todos</span>
        <span className="todo-count">{completed} of {todos.length}</span>
        <span className="todo-progress" aria-label={`${progress}% complete`}>
          <span style={{ width: `${progress}%` }} />
        </span>
        <i className="bi bi-chevron-down todo-chevron" aria-hidden="true" />
      </summary>
      <div className="todo-list">
        {todos.map((todo, index) => {
          const presentation = todoPresentation[todo.status];
          return (
            <div className={`todo-item todo-${todo.status}`} key={`${todo.content}-${index}`}>
              <span className="todo-state-icon" title={presentation.label}>
                <i className={`bi ${presentation.icon}`} aria-hidden="true" />
                <span className="visually-hidden">{presentation.label}</span>
              </span>
              <span className="todo-content">{todo.content}</span>
              <span className="todo-status-label">{presentation.label}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function toolTitle(part: ToolPart) {
  return "title" in part.state && part.state.title ? part.state.title : part.tool;
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function toolDuration(part: ToolPart, now = Date.now()) {
  if (!("time" in part.state)) return null;
  const end = "end" in part.state.time ? part.state.time.end : undefined;
  return formatDuration(Math.max(0, (end || now) - part.state.time.start));
}

function timedPartsDuration(parts: Array<ToolPart | ReasoningPart>, now = Date.now()) {
  const times: Array<{ start: number; end?: number }> = parts.flatMap((part) => {
    if (part.type === "tool") {
      if (!("time" in part.state)) return [];
      return [{
        start: part.state.time.start,
        end: "end" in part.state.time ? part.state.time.end : undefined,
      }];
    }
    return [{ start: part.time.start, end: part.time.end }];
  });
  if (!times.length) return null;
  const start = Math.min(...times.map((time) => time.start));
  const isRunning = parts.some((part) =>
    part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
  ) || times.some((time) => time.end === undefined);
  const end = isRunning ? now : Math.max(...times.map((time) => time.end || time.start));
  return formatDuration(Math.max(0, end - start));
}

function turnDuration(message: ThreadMessage, now = Date.now()) {
  const partEnds = message.parts.flatMap((part) => {
    if ((part.type === "text" || part.type === "reasoning") && part.time?.end) return [part.time.end];
    if (part.type === "tool" && "time" in part.state && "end" in part.state.time && part.state.time.end) return [part.state.time.end];
    return [];
  });
  const end = message.completed || (message.error && partEnds.length ? Math.max(...partEnds) : now);
  return formatDuration(Math.max(0, end - message.created));
}

function toolGroupStatus(tools: ToolPart[]) {
  if (tools.some((part) => part.state.status === "error")) return "error";
  if (tools.some((part) => part.state.status === "running" || part.state.status === "pending")) return "running";
  return "completed";
}

function toolGroupTitle(tools: ToolPart[]) {
  const kinds = new Set(tools.map((part) => part.tool.toLowerCase()));
  const onlyKind = kinds.size === 1 ? tools[0].tool.toLowerCase() : "";
  if (tools.length === 1) {
    if (onlyKind.includes("read")) return `Read ${toolTitle(tools[0])}`;
    if (onlyKind.includes("glob") || onlyKind.includes("grep") || onlyKind.includes("search")) return "Searched files";
    if (onlyKind.includes("bash") || onlyKind.includes("shell") || onlyKind.includes("command")) return "Ran a command";
    if (onlyKind.includes("write") || onlyKind.includes("edit") || onlyKind.includes("patch")) return `Changed ${toolTitle(tools[0])}`;
    return toolTitle(tools[0]);
  }
  if (onlyKind.includes("read")) return `Read ${tools.length} files`;
  if (onlyKind.includes("glob") || onlyKind.includes("grep") || onlyKind.includes("search")) return `Searched files ${tools.length} times`;
  if (onlyKind.includes("bash") || onlyKind.includes("shell") || onlyKind.includes("command")) return `Ran ${tools.length} commands`;
  if (onlyKind.includes("write") || onlyKind.includes("edit") || onlyKind.includes("patch")) return `Changed ${tools.length} files`;
  return `Used ${tools.length} tools`;
}

function toolGroupKind(tools: ToolPart[]) {
  const kinds = new Set(tools.map((part) => part.tool.toLowerCase()));
  return kinds.size === 1 ? tools[0].tool : `${tools.length} calls`;
}

function ToolRow({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const status = part.state.status;
  const title = toolTitle(part);
  const duration = toolDuration(part);
  return (
    <details className="tool-row">
      <summary>
        <span className={`tool-status tool-status-${status}`} aria-hidden="true">
          {status === "completed" ? <i className="bi bi-check2" /> : <i className="bi bi-terminal" />}
        </span>
        <span className="text-truncate">{title}</span>
        <span className="tool-kind">{part.tool}</span>
        {duration && <span className="step-duration" title="Step duration">{duration}</span>}
        <i className="bi bi-chevron-right tool-chevron" aria-hidden="true" />
      </summary>
      <pre>{"output" in part.state ? part.state.output : JSON.stringify(part.state.input, null, 2)}</pre>
    </details>
  );
}

function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const status = toolGroupStatus(tools);
  const duration = timedPartsDuration(tools);
  return (
    <details className="tool-stack">
      <summary className="tool-stack-summary">
        <span className={`tool-status tool-status-${status}`} aria-hidden="true">
          {status === "completed" ? <i className="bi bi-check2" /> : <i className="bi bi-terminal" />}
        </span>
        <span className="text-truncate">{toolGroupTitle(tools)}</span>
        <span className="tool-kind">{toolGroupKind(tools)}</span>
        {duration && <span className="step-duration group-duration" title="Group duration">{duration}</span>}
        <i className="bi bi-chevron-right tool-chevron" aria-hidden="true" />
      </summary>
      <div className="tool-stack-items">
        {tools.map((part) => <ToolRow key={part.id} part={part} />)}
      </div>
    </details>
  );
}

function combineConversationTurns(messages: ThreadMessage[]) {
  return messages.reduce<ThreadMessage[]>((turns, message) => {
    const previous = turns[turns.length - 1];
    const sameAssistantTurn = message.role === "assistant"
      && previous?.role === "assistant"
      && previous.provider === message.provider
      && previous.model === message.model
      && previous.agent === message.agent;
    if (!sameAssistantTurn) return [...turns, message];
    const errors = Array.from(new Set([previous.error, message.error].filter(Boolean)));
    return [
      ...turns.slice(0, -1),
      {
        ...previous,
        id: `${previous.id}:${message.id}`,
        completed: message.completed,
        error: errors.length ? errors.join("\n") : undefined,
        parts: [...previous.parts, ...message.parts],
      },
    ];
  }, []);
}

function assistantBlocks(parts: Part[]) {
  const blocks: AssistantBlock[] = [];
  parts.forEach((part) => {
    const previous = blocks[blocks.length - 1];
    if (part.type === "reasoning") {
      if (previous?.type === "reasoning") previous.parts.push(part);
      else blocks.push({ type: "reasoning", parts: [part] });
    } else if (part.type === "tool") {
      if (previous?.type === "tools") previous.parts.push(part);
      else blocks.push({ type: "tools", parts: [part] });
    } else if (part.type === "file") {
      if (previous?.type === "files") previous.parts.push(part);
      else blocks.push({ type: "files", parts: [part] });
    } else if (part.type === "text" && !part.ignored) {
      if (previous?.type === "text") previous.parts.push(part);
      else blocks.push({ type: "text", parts: [part] });
    }
  });
  return blocks;
}

function FileChips({ files }: { files: FilePart[] }) {
  if (!files.length) return null;
  return (
    <div className="message-files">
      {files.map((file) => (
        <span key={file.id}><i className="bi bi-file-earmark" />{file.filename || file.mime}</span>
      ))}
    </div>
  );
}

function reasoningPreview(text: string) {
  return text
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[\\`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ReasoningBlock({ parts }: { parts: ReasoningPart[] }) {
  const text = parts.map((part) => part.text).join("\n\n").trim();
  const preview = reasoningPreview(text) || "Planning";
  const duration = timedPartsDuration(parts);
  const expandable = parts.length > 1 || text.includes("\n") || preview.length > 140;
  if (!expandable) {
    return (
      <div className="reasoning-inline">
        <i className="bi bi-stars" aria-hidden="true" />
        <span className="reasoning-preview">{preview}</span>
        {duration && <span className="reasoning-duration" title="Reasoning duration">{duration}</span>}
      </div>
    );
  }
  return (
    <details className="reasoning">
      <summary>
        <i className="bi bi-stars" aria-hidden="true" />
        <span className="reasoning-preview">{preview}</span>
        {duration && <span className="reasoning-duration" title="Reasoning duration">{duration}</span>}
        <i className="bi bi-chevron-right reasoning-chevron" aria-hidden="true" />
      </summary>
      <div className="reasoning-copy markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </details>
  );
}

function Message({ message }: { message: ThreadMessage }) {
  const textParts = message.parts.filter(
    (part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored,
  );
  const files = message.parts.filter(
    (part): part is Extract<Part, { type: "file" }> => part.type === "file",
  );

  if (message.role === "user") {
    return (
      <article className="message message-user">
        <div className="message-meta">
          <span>You</span>
          <time>{timeLabel(message.created)}</time>
        </div>
        {textParts.map((part) => (
          <p key={part.id}>{part.text}</p>
        ))}
        <FileChips files={files} />
      </article>
    );
  }

  const blocks = assistantBlocks(message.parts);
  const wasStopped = Boolean(message.error && /\baborted\b/i.test(message.error));
  const totalDuration = turnDuration(message);

  return (
    <article className="message message-assistant">
      <div className="message-body">
        <div className="message-meta">
          <span>OpenCode</span>
          <span className="model-label">{message.model || "agent"}</span>
          <span className="turn-duration" title="Total turn duration"><i className="bi bi-clock" aria-hidden="true" /> {totalDuration} total</span>
          <time>{timeLabel(message.created)}</time>
        </div>
        {blocks.map((block) => {
          const key = block.parts[0].id;
          if (block.type === "reasoning") {
            return <ReasoningBlock parts={block.parts} key={key} />;
          }
          if (block.type === "tools") return <ToolGroup tools={block.parts} key={key} />;
          if (block.type === "files") return <FileChips files={block.parts} key={key} />;
          return (
            <div className="assistant-copy markdown-body" key={key}>
              {block.parts.map((part) => (
                <ReactMarkdown
                  key={part.id}
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">{children}</a>
                    ),
                  }}
                >
                  {part.text}
                </ReactMarkdown>
              ))}
            </div>
          );
        })}
        {wasStopped ? (
          <div className="assistant-stopped" role="status">
            <i className="bi bi-stop-circle" aria-hidden="true" />
            <span>Agent stopped</span>
          </div>
        ) : message.error && (
          <div className="assistant-error" role="alert">
            <i className="bi bi-exclamation-triangle" aria-hidden="true" />
            <span>
              <strong>Agent request failed</strong>
              <span>{message.error}</span>
              <small>Choose another model and send the prompt again.</small>
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [groupMode, setGroupMode] = useState<GroupMode>(loadGroupMode);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pinnedSessionIDs, setPinnedSessionIDs] = useState<string[]>(loadPinnedSessionIDs);
  const [readSessionUpdates, setReadSessionUpdates] = useState<Record<string, number>>(loadReadSessionUpdates);
  const [busySessionIDs, setBusySessionIDs] = useState<string[]>([]);
  const [locallySendingSessionIDs, setLocallySendingSessionIDs] = useState<string[]>([]);
  const [activeID, setActiveID] = useState("");
  const [messages, setMessages] = useState<Record<string, ThreadMessage[]>>({});
  const [connection, setConnection] = useState<OpenCodeConnection | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDirectory, setNewTaskDirectory] = useState("");
  const [newTaskError, setNewTaskError] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("agent-center-url") || DEFAULT_URL);
  const [directory, setDirectory] = useState(() => localStorage.getItem("agent-center-directory") || "");
  const [password, setPassword] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [renamingSessionID, setRenamingSessionID] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [confirmDeleteSessionID, setConfirmDeleteSessionID] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [stoppingSessionID, setStoppingSessionID] = useState("");
  const [draft, setDraft] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [composerError, setComposerError] = useState("");
  const [recentDirectories, setRecentDirectories] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const agentControlRef = useRef<HTMLDivElement>(null);
  const modelControlRef = useRef<HTMLDivElement>(null);
  const autoConnectStarted = useRef(false);
  const intentionallyStoppedSessionIDs = useRef(new Set<string>());
  const sendingSessionIDs = useRef(new Set<string>());
  const activeSessionIDRef = useRef("");

  const knownDirectories = useMemo(() => Array.from(new Set([
    ...recentDirectories,
    ...sessions.map((session) => session.directory),
  ])), [recentDirectories, sessions]);

  const sessionsByID = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const childSessionsByParent = useMemo(() => {
    const children: Record<string, Session[]> = {};
    sessions.forEach((session) => {
      if (session.parentID) (children[session.parentID] ||= []).push(session);
    });
    Object.values(children).forEach((items) => items.sort((a, b) => b.time.updated - a.time.updated));
    return children;
  }, [sessions]);
  const activeSession = sessions.find((session) => session.id === activeID)
    || sessions.find((session) => !session.parentID)
    || sessions[0];
  const activeParentSession = activeSession?.parentID ? sessionsByID.get(activeSession.parentID) : undefined;
  const activeSubagents = activeSession ? childSessionsByParent[activeSession.id] || [] : [];
  const activeMessages = activeSession ? messages[activeSession.id] || [] : [];
  const conversationTurns = useMemo(() => combineConversationTurns(activeMessages), [activeMessages]);
  const activeTodos = useMemo(() => latestTodos(activeMessages), [activeMessages]);
  const sessionFamily = (session: Session) => {
    const seen = new Set<string>();
    const collect = (item: Session): Session[] => {
      if (seen.has(item.id)) return [];
      seen.add(item.id);
      return [item, ...(childSessionsByParent[item.id] || []).flatMap(collect)];
    };
    return collect(session);
  };
  const sessionActivity = (session: Session) => {
    const family = sessionFamily(session);
    const busy = family.some((item) =>
      busySessionIDs.includes(item.id)
      || locallySendingSessionIDs.includes(item.id)
      || stoppingSessionID === item.id,
    );
    const unread = !busy && family.some((item) =>
      item.id !== activeSession?.id && item.time.updated > (readSessionUpdates[item.id] || 0),
    );
    return { busy, unread };
  };
  const automaticModel = useMemo(() => {
    const agentModel = agents.find((agent) => agent.name === selectedAgent)?.model;
    if (agentModel) {
      const match = models.find((model) =>
        model.providerID === agentModel.providerID && model.modelID === agentModel.modelID,
      );
      if (match) return match;
    }
    const lastUsedMessage = [...activeMessages].reverse().find((message) => message.model);
    return models.find((model) =>
      model.modelID === lastUsedMessage?.model
      && (!lastUsedMessage.provider || model.providerID === lastUsedMessage.provider),
    )
      || models.find((model) => model.isDefault)
      || models[0]
      || null;
  }, [activeMessages, agents, models, selectedAgent]);
  const displayedModel = selectedModel || automaticModel;
  const activeSessionIsBusy = Boolean(activeSession && sessionActivity(activeSession).busy);

  const groupedSessions = useMemo(() => {
    const query = search.toLowerCase();
    const treeMatches = (session: Session): boolean =>
      session.title.toLowerCase().includes(query)
      || (childSessionsByParent[session.id] || []).some(treeMatches);
    const filtered = sessions
      .filter((session) => !session.parentID)
      .filter((session) => treeMatches(session))
      .sort((a, b) => b.time.updated - a.time.updated);
    const latestProjectActivity = new Map<string, number>();
    filtered.forEach((session) => {
      latestProjectActivity.set(session.directory, Math.max(latestProjectActivity.get(session.directory) || 0, session.time.updated));
    });
    const pinned = filtered.filter((session) => pinnedSessionIDs.includes(session.id));
    const recent = filtered.filter((session) => !pinnedSessionIDs.includes(session.id));
    const groups = recent.reduce<Record<string, Session[]>>((result, session) => {
      const group = groupMode === "date" ? dayGroup(session.time.updated) : session.directory;
      (result[group] ||= []).push(session);
      return result;
    }, {});
    const groupList = Object.entries(groups).map(([key, items]) => ({
      key,
      label: groupMode === "date" ? key : basename(key),
      items,
    }));
    if (groupMode === "project") {
      groupList.sort((a, b) =>
        (latestProjectActivity.get(b.key) || 0) - (latestProjectActivity.get(a.key) || 0)
        || a.label.localeCompare(b.label),
      );
    }
    return { pinned, groups: groupList };
  }, [sessions, search, pinnedSessionIDs, groupMode, childSessionsByParent]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const matching = query
      ? models.filter((model) => `${model.name} ${model.modelID} ${model.providerName}`.toLowerCase().includes(query))
      : models;
    return matching.slice(0, 80);
  }, [models, modelSearch]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [activeID, activeMessages.length, activeSessionIsBusy]);

  useEffect(() => {
    activeSessionIDRef.current = activeSession?.id || "";
  }, [activeSession?.id]);

  useEffect(() => {
    function closeAgentMenu(event: PointerEvent) {
      if (!agentControlRef.current?.contains(event.target as Node)) setAgentMenuOpen(false);
      if (!modelControlRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeAgentMenu);
    return () => document.removeEventListener("pointerdown", closeAgentMenu);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = resolveTheme(themeMode);
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.bsTheme = theme;
      document.documentElement.style.colorScheme = theme;
    };
    applyTheme();
    localStorage.setItem(THEME_KEY, themeMode);
    if (themeMode !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  useEffect(() => {
    if (autoConnectStarted.current) return;
    autoConnectStarted.current = true;
    void connectToServer(serverUrl, directory, "", true);
  }, []);

  useEffect(() => {
    localStorage.setItem(GROUP_MODE_KEY, groupMode);
  }, [groupMode]);

  useEffect(() => {
    if (!connection) return;
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const nextSessions = await listSessions(connection);
        const statuses = await listSessionStatuses(
          connection,
          nextSessions.map((session) => session.directory),
        );
        if (disposed) return;
        setBusySessionIDs(Object.entries(statuses)
          .filter(([, status]) => status.type === "busy" || status.type === "retry")
          .map(([sessionID]) => sessionID));
        setSessions(nextSessions);
        const active = nextSessions.find((session) => session.id === activeID);
        if (active) markSessionRead(active);
      } catch {
        // Keep the current sidebar stable during a transient polling failure.
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [connection, activeID]);

  useEffect(() => {
    if (!connection || !activeSession) return;
    let disposed = false;
    let refreshing = false;
    const sessionID = activeSession.id;
    const sessionDirectory = activeSession.directory;
    const refreshMessages = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await listMessages(connection, sessionID, sessionDirectory);
        if (disposed) return;
        setMessages((current) => {
          const existing = current[sessionID] || [];
          if (messageListRevision(existing) === messageListRevision(next)) return current;
          return { ...current, [sessionID]: next };
        });
      } catch {
        // A later refresh can recover from transient message-list failures.
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(() => void refreshMessages(), 1_250);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [connection, activeSession?.id, activeSession?.directory]);

  function markSessionRead(session: Session) {
    setReadSessionUpdates((current) => {
      if ((current[session.id] || 0) >= session.time.updated) return current;
      const next = { ...current, [session.id]: session.time.updated };
      localStorage.setItem(READ_SESSIONS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function selectSession(session: Session) {
    activeSessionIDRef.current = session.id;
    setActiveID(session.id);
    setComposerError("");
    markSessionRead(session);
    let parentID = session.parentID;
    while (parentID) {
      const parent = sessionsByID.get(parentID);
      if (!parent) break;
      markSessionRead(parent);
      parentID = parent.parentID;
    }
    setSidebarOpen(false);
    if (!connection || messages[session.id]) return;
    setLoadingMessages(true);
    try {
      const next = await listMessages(connection, session.id, session.directory);
      setMessages((current) => ({ ...current, [session.id]: next }));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Could not load messages.");
    } finally {
      setLoadingMessages(false);
    }
  }

  async function connectToServer(
    nextServerUrl: string,
    nextDirectory: string,
    nextPassword: string,
    openOnFailure = false,
  ) {
    setConnectionState("connecting");
    setConnectionError("");
    try {
      const nextConnection = createConnection({
        baseUrl: nextServerUrl,
        directory: nextDirectory,
        password: nextPassword,
      });
      const [nextSessions, nextAgents, nextModels, nextDirectories] = await Promise.all([
        listSessions(nextConnection),
        listAgents(nextConnection),
        listModels(nextConnection),
        listRecentProjectDirectories(nextConnection),
      ]);
      setConnection(nextConnection);
      setConnectionState("connected");
      setSessions(nextSessions);
      setReadSessionUpdates((current) => {
        let changed = false;
        const next = { ...current };
        nextSessions.forEach((session) => {
          if (next[session.id] === undefined) {
            next[session.id] = session.time.updated;
            changed = true;
          }
        });
        if (changed) localStorage.setItem(READ_SESSIONS_KEY, JSON.stringify(next));
        return changed ? next : current;
      });
      setAgents(nextAgents);
      setModels(nextModels);
      setRecentDirectories(nextDirectories);
      setSelectedModel(null);
      setModelSearch("");
      setSelectedAgent((current) =>
        nextAgents.some((agent) => agent.name === current)
          ? current
          : nextAgents.find((agent) => agent.name === "build")?.name || nextAgents[0]?.name || "build",
      );
      setMessages({});
      localStorage.setItem("agent-center-url", nextConnection.options.baseUrl);
      localStorage.setItem("agent-center-directory", nextDirectory);
      setPassword("");
      setConnectionOpen(false);
      const initialSession = nextSessions.find((session) =>
        !session.parentID && (!nextDirectory || session.directory === nextDirectory),
      ) || nextSessions.find((session) => !session.parentID) || nextSessions[0];
      if (initialSession) {
        setActiveID(initialSession.id);
        await selectSessionWith(nextConnection, initialSession);
      } else {
        setActiveID("");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The server did not respond.";
      setConnection(null);
      setConnectionState("error");
      setConnectionError(`OpenCode is not available at ${nextServerUrl}. ${detail}`);
      setSessions([]);
      setMessages({});
      setActiveID("");
      setAgents([]);
      setModels([]);
      setBusySessionIDs([]);
      setSelectedAgent("");
      setSelectedModel(null);
      if (openOnFailure) setConnectionOpen(true);
    }
  }

  function handleConnect(event: FormEvent) {
    event.preventDefault();
    void connectToServer(serverUrl, directory, password);
  }

  async function selectSessionWith(nextConnection: OpenCodeConnection, session: Session) {
    setLoadingMessages(true);
    try {
      const next = await listMessages(nextConnection, session.id, session.directory);
      setMessages({ [session.id]: next });
    } finally {
      setLoadingMessages(false);
    }
  }

  function showNewTaskPicker() {
    if (!connection) {
      setConnectionError(`Connect to an OpenCode server before creating a task.`);
      setConnectionOpen(true);
      return;
    }
    setDirectoryOpen(false);
    setNewTaskDirectory(activeSession?.directory || connection.options.directory || recentDirectories[0] || "");
    setNewTaskError("");
    setNewTaskOpen((open) => !open);
  }

  async function handleNewSession(nextDirectory: string) {
    if (!connection) {
      setConnectionError(`Connect to an OpenCode server before creating a task.`);
      setConnectionOpen(true);
      return;
    }
    const targetDirectory = nextDirectory.trim();
    if (!targetDirectory) {
      setNewTaskError("Enter a project path.");
      return;
    }
    setCreatingSession(true);
    setNewTaskError("");
    const preferredModel = displayedModel && !activeMessages.some((message) =>
      message.error
      && message.provider === displayedModel.providerID
      && message.model === displayedModel.modelID,
    ) ? displayedModel : null;
    try {
      const taskConnection = connection.options.directory === targetDirectory
        ? connection
        : createConnection({ ...connection.options, directory: targetDirectory });
      const session = await createSession(taskConnection, targetDirectory);
      activeSessionIDRef.current = session.id;
      setConnection(taskConnection);
      setDirectory(targetDirectory);
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setMessages((current) => ({ ...current, [session.id]: [] }));
      setActiveID(session.id);
      setRecentDirectories((current) => [targetDirectory, ...current.filter((item) => item !== targetDirectory)]);
      localStorage.setItem("agent-center-directory", targetDirectory);
      markSessionRead(session);
      setNewTaskOpen(false);
      setSidebarOpen(false);

      const [agentsResult, modelsResult, recentModelResult] = await Promise.allSettled([
        listAgents(taskConnection),
        listModels(taskConnection),
        findRecentSuccessfulModel(taskConnection),
      ]);
      const nextAgents = agentsResult.status === "fulfilled" ? agentsResult.value : agents;
      const nextModels = modelsResult.status === "fulfilled" ? modelsResult.value : models;
      const recentSuccessfulModel = recentModelResult.status === "fulfilled" ? recentModelResult.value : null;
      if (agentsResult.status === "fulfilled") setAgents(nextAgents);
      if (modelsResult.status === "fulfilled") setModels(nextModels);
      const nextAgent = nextAgents.find((agent) => agent.name === "build") || nextAgents[0];
      const nextModel = nextModels.find((model) =>
        model.providerID === preferredModel?.providerID && model.modelID === preferredModel.modelID,
      ) || nextModels.find((model) =>
        model.providerID === recentSuccessfulModel?.providerID && model.modelID === recentSuccessfulModel.modelID,
      ) || nextModels.find((model) =>
        model.providerID === nextAgent?.model?.providerID && model.modelID === nextAgent.model.modelID,
      ) || nextModels.find((model) => model.isDefault) || nextModels[0] || null;
      setSelectedModel(nextModel);
      setSelectedAgent(nextAgent?.name || "build");
    } catch (error) {
      setNewTaskError(error instanceof Error ? error.message : "Could not create a session.");
    } finally {
      setCreatingSession(false);
    }
  }

  function handleNewSessionSubmit(event: FormEvent) {
    event.preventDefault();
    void handleNewSession(newTaskDirectory);
  }

  function showDirectoryPicker() {
    setNewTaskOpen(false);
    setDirectoryDraft(connection?.options.directory || activeSession?.directory || "");
    setDirectoryOpen(true);
  }

  async function openDirectory(nextDirectory: string) {
    const targetDirectory = nextDirectory.trim();
    setDirectoryDraft(targetDirectory);
    setDirectory(targetDirectory);
    setDirectoryOpen(false);
    await connectToServer(
      connection?.options.baseUrl || serverUrl,
      targetDirectory,
      connection?.options.password || password,
      true,
    );
  }

  function handleOpenDirectory(event: FormEvent) {
    event.preventDefault();
    void openDirectory(directoryDraft);
  }

  function togglePinned(sessionID: string) {
    setPinnedSessionIDs((current) => {
      const next = current.includes(sessionID)
        ? current.filter((id) => id !== sessionID)
        : [sessionID, ...current];
      localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function beginRename(session: Session) {
    setRenamingSessionID(session.id);
    setRenameDraft(session.title);
    setRenameError("");
  }

  function cancelRename() {
    if (renameSaving) return;
    setRenamingSessionID("");
    setRenameDraft("");
    setRenameError("");
  }

  async function handleRename(event: FormEvent, session: Session) {
    event.preventDefault();
    const title = renameDraft.trim();
    if (!title) {
      setRenameError("Enter a task name.");
      return;
    }
    if (title === session.title) {
      cancelRename();
      return;
    }
    if (!connection) {
      setRenameError("Reconnect to OpenCode to rename this task.");
      return;
    }
    setRenameSaving(true);
    setRenameError("");
    try {
      const updated = await renameSession(connection, session.id, title, session.directory);
      setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setRenamingSessionID("");
      setRenameDraft("");
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "OpenCode could not rename this task.");
    } finally {
      setRenameSaving(false);
    }
  }

  function beginDelete(session: Session) {
    if (renameSaving || deleteSaving) return;
    cancelRename();
    setConfirmDeleteSessionID(session.id);
    setDeleteError("");
  }

  function cancelDelete() {
    if (deleteSaving) return;
    setConfirmDeleteSessionID("");
    setDeleteError("");
  }

  async function handleDelete(session: Session) {
    if (!connection) {
      setDeleteError("Reconnect to OpenCode to delete this task.");
      return;
    }
    const familyIDs = new Set([session.id]);
    let foundChild = true;
    while (foundChild) {
      foundChild = false;
      sessions.forEach((item) => {
        if (item.parentID && familyIDs.has(item.parentID) && !familyIDs.has(item.id)) {
          familyIDs.add(item.id);
          foundChild = true;
        }
      });
    }
    setDeleteSaving(true);
    setDeleteError("");
    try {
      await deleteSession(connection, session.id, session.directory);
      const remaining = sessions.filter((item) => !familyIDs.has(item.id));
      setSessions(remaining);
      setMessages((current) => {
        const next = { ...current };
        familyIDs.forEach((sessionID) => delete next[sessionID]);
        return next;
      });
      setPinnedSessionIDs((current) => {
        const next = current.filter((sessionID) => !familyIDs.has(sessionID));
        localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(next));
        return next;
      });
      setReadSessionUpdates((current) => {
        const next = { ...current };
        familyIDs.forEach((sessionID) => delete next[sessionID]);
        localStorage.setItem(READ_SESSIONS_KEY, JSON.stringify(next));
        return next;
      });
      setBusySessionIDs((current) => current.filter((sessionID) => !familyIDs.has(sessionID)));
      setLocallySendingSessionIDs((current) => current.filter((sessionID) => !familyIDs.has(sessionID)));
      if (activeSession && familyIDs.has(activeSession.id)) {
        const replacement = remaining.find((item) => !item.parentID) || remaining[0];
        if (replacement) await selectSession(replacement);
        else setActiveID("");
      }
      setConfirmDeleteSessionID("");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete this task.");
    } finally {
      setDeleteSaving(false);
    }
  }

  async function addAttachments(files: File[]) {
    if (files.length === 0) return;
    setComposerError("");
    if (attachments.length + files.length > MAX_ATTACHMENT_COUNT) {
      setComposerError(`Attach up to ${MAX_ATTACHMENT_COUNT} files at a time.`);
      return;
    }
    const oversized = files.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setComposerError(`${oversized.name} is larger than 10 MB.`);
      return;
    }
    try {
      const next = await Promise.all(files.map(readAttachment));
      setAttachments((current) => [...current, ...next]);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : "Could not attach this file.");
    }
  }

  function handleAttachments(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    void addAttachments(files);
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const itemImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const imageFiles = itemImages.length > 0
      ? itemImages
      : Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addAttachments(imageFiles);
  }

  async function handleSend() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || !activeSession || !connection || activeSessionIsBusy) return;
    const session = activeSession;
    if (sendingSessionIDs.current.has(session.id)) return;
    sendingSessionIDs.current.add(session.id);
    const sendingAttachments = attachments;
    setDraft("");
    setAttachments([]);
    setComposerError("");
    const messageID = `local_${Date.now()}`;
    const optimistic: ThreadMessage = {
      id: messageID,
      role: "user",
      created: Date.now(),
      agent: selectedAgent,
      parts: [
        ...(text ? [{
          id: `local_text_${Date.now()}`,
          sessionID: session.id,
          messageID,
          type: "text" as const,
          text,
        }] : []),
        ...sendingAttachments.map((file) => ({
          id: file.id,
          sessionID: session.id,
          messageID,
          type: "file" as const,
          mime: file.mime,
          filename: file.name,
          url: file.dataUrl,
        })),
      ],
    };
    setMessages((current) => ({
      ...current,
      [session.id]: [...(current[session.id] || []), optimistic],
    }));
    setLocallySendingSessionIDs((current) => current.includes(session.id) ? current : [...current, session.id]);
    try {
      await sendPrompt(
        connection,
        session.id,
        text,
        selectedAgent || undefined,
        displayedModel || undefined,
        sendingAttachments,
        session.directory,
      );
      const next = await listMessages(connection, session.id, session.directory);
      setMessages((current) => ({ ...current, [session.id]: next }));
    } catch (error) {
      if (intentionallyStoppedSessionIDs.current.has(session.id)) {
        try {
          const next = await listMessages(connection, session.id, session.directory);
          setMessages((current) => ({ ...current, [session.id]: next }));
        } catch {
          // Polling will reconcile the final stopped state.
        }
      } else {
        setMessages((current) => ({
          ...current,
          [session.id]: (current[session.id] || []).filter((message) => message.id !== messageID),
        }));
        if (activeSessionIDRef.current === session.id) {
          setComposerError(error instanceof Error ? error.message : "The prompt could not be sent.");
          setDraft((current) => current || text);
          setAttachments((current) => current.length > 0 ? current : sendingAttachments);
        }
      }
    } finally {
      intentionallyStoppedSessionIDs.current.delete(session.id);
      sendingSessionIDs.current.delete(session.id);
      setLocallySendingSessionIDs((current) => current.filter((sessionID) => sessionID !== session.id));
    }
  }

  async function handleStop() {
    if (!activeSession || !connection || stoppingSessionID) return;
    const session = activeSession;
    const locallySending = locallySendingSessionIDs.includes(session.id);
    if (locallySending) intentionallyStoppedSessionIDs.current.add(session.id);
    setStoppingSessionID(session.id);
    setComposerError("");
    try {
      await abortSession(connection, session.id, session.directory);
      setBusySessionIDs((current) => current.filter((sessionID) => sessionID !== session.id));
      setLocallySendingSessionIDs((current) => current.filter((sessionID) => sessionID !== session.id));
      const next = await listMessages(connection, session.id, session.directory);
      setMessages((current) => ({ ...current, [session.id]: next }));
    } catch (error) {
      if (locallySending) intentionallyStoppedSessionIDs.current.delete(session.id);
      setComposerError(error instanceof Error ? error.message : "Could not stop this task.");
    } finally {
      setStoppingSessionID("");
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function taskIndicator(session: Session) {
    const { busy, unread } = sessionActivity(session);
    if (!busy && !unread) return null;
    const label = busy ? "Task in progress" : "Unread task";
    return (
      <span className={`task-indicator ${busy ? "is-busy" : "is-unread"}`} title={label}>
        <span className="visually-hidden">{label}</span>
      </span>
    );
  }

  function renderSubagentTree(session: Session, depth = 0) {
    const children = childSessionsByParent[session.id] || [];
    return (
      <div className={`subagent-entry ${session.id === activeSession?.id ? "active" : ""}`} key={session.id}>
        <button
          className="subagent-open"
          style={{ paddingLeft: `${10 + depth * 12}px` }}
          onClick={() => void selectSession(session)}
          aria-label={`View subagent: ${subagentTitle(session.title)}`}
          title={session.title}
        >
          <i className="bi bi-diagram-2" aria-hidden="true" />
          <span className="subagent-copy">
            <span className="subagent-title">{subagentTitle(session.title)}</span>
            <small>@{subagentName(session.title)}</small>
          </span>
          <time>{timeLabel(session.time.updated)}</time>
          {taskIndicator(session)}
        </button>
        {children.length > 0 && (
          <details className="subagent-nested" open={search.trim() ? true : undefined}>
            <summary>
              <i className="bi bi-chevron-right" aria-hidden="true" />
              {children.length} nested {children.length === 1 ? "subagent" : "subagents"}
            </summary>
            {children.map((child) => renderSubagentTree(child, depth + 1))}
          </details>
        )}
      </div>
    );
  }

  function renderSessionTree(session: Session, pinned: boolean) {
    const children = childSessionsByParent[session.id] || [];
    const activeChild = activeSession?.parentID && (() => {
      let parentID: string | undefined = activeSession.parentID;
      while (parentID) {
        if (parentID === session.id) return true;
        parentID = sessionsByID.get(parentID)?.parentID;
      }
      return false;
    })();
    return (
      <div className={`thread-tree ${activeChild ? "has-active-subagent" : ""}`} key={session.id}>
        {renderSessionRow(session, pinned)}
        {children.length > 0 && (
          <details className="subagent-group" open={search.trim() ? true : undefined}>
            <summary>
              <i className="bi bi-diagram-2" aria-hidden="true" />
              <span>{children.length} {children.length === 1 ? "subagent" : "subagents"}</span>
              <i className="bi bi-chevron-right subagent-chevron" aria-hidden="true" />
            </summary>
            <div className="subagent-list">
              {children.map((child) => renderSubagentTree(child))}
            </div>
          </details>
        )}
      </div>
    );
  }

  function renderSessionRow(session: Session, pinned: boolean) {
    const isRenaming = renamingSessionID === session.id;
    const isConfirmingDelete = confirmDeleteSessionID === session.id;
    return (
      <div
        className={`thread-row ${pinned ? "is-pinned-row" : ""} ${session.id === activeSession?.id ? "active" : ""}`}
        key={session.id}
      >
        {isConfirmingDelete ? (
          <div className="thread-delete-confirm" role="group" aria-label={`Confirm deletion of ${session.title}`}>
            <span className={deleteError ? "has-error" : ""} title={deleteError || `Delete ${session.title}`}>
              {deleteError || "Delete task?"}
            </span>
            <button
              type="button"
              autoFocus
              onClick={cancelDelete}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelDelete();
                }
              }}
              disabled={deleteSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="confirm-delete-button"
              onClick={() => void handleDelete(session)}
              disabled={deleteSaving}
            >
              {deleteSaving ? "Deleting…" : "Delete"}
            </button>
          </div>
        ) : isRenaming ? (
          <form className="thread-rename-form" onSubmit={(event) => void handleRename(event, session)}>
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => {
                setRenameDraft(event.target.value);
                if (renameError) setRenameError("");
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              aria-label={`Rename ${session.title}`}
              aria-invalid={Boolean(renameError)}
              title={renameError || undefined}
              disabled={renameSaving}
            />
            <button type="submit" aria-label="Save task name" title="Save" disabled={renameSaving}>
              <i className={`bi ${renameSaving ? "bi-arrow-repeat" : "bi-check-lg"}`} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Cancel rename" title="Cancel" onClick={cancelRename} disabled={renameSaving}>
              <i className="bi bi-x-lg" aria-hidden="true" />
            </button>
            {renameError && <span className="visually-hidden" role="alert">{renameError}</span>}
          </form>
        ) : (
          <>
            <button className="thread-open" onClick={() => void selectSession(session)}>
              <span className="thread-title text-truncate" title={session.title}>{session.title}</span>
              <time>{timeLabel(session.time.updated)}</time>
              <span className="thread-project text-truncate">{basename(session.directory)}</span>
              {taskIndicator(session)}
            </button>
            <button
              className="thread-rename"
              onClick={() => beginRename(session)}
              aria-label={`Rename ${session.title}`}
              title="Rename task"
            >
              <i className="bi bi-pencil" aria-hidden="true" />
            </button>
            <button
              className={`thread-pin ${pinned ? "is-pinned" : ""}`}
              onClick={() => togglePinned(session.id)}
              aria-label={`${pinned ? "Unpin" : "Pin"} ${session.title}`}
              aria-pressed={pinned}
              title={`${pinned ? "Unpin" : "Pin"} task`}
            >
              <i className={`bi ${pinned ? "bi-pin-angle-fill" : "bi-pin-angle"}`} aria-hidden="true" />
            </button>
            <button
              className="thread-delete"
              onClick={() => beginDelete(session)}
              aria-label={`Delete ${session.title}`}
              title="Delete task"
            >
              <i className="bi bi-trash3" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
      <aside className={`thread-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="sidebar-top">
          <div className="brand-row">
            <div className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path
                  className="brain-base"
                  d="M12 5.1c-.6-1.5-2-2.4-3.5-2.2-1.6.2-2.7 1.5-2.7 3.1-1.6.3-2.7 1.7-2.6 3.3 0 1 .5 1.9 1.3 2.5-1.2.8-1.8 2.2-1.4 3.6.4 1.4 1.6 2.3 3 2.4.5 1.8 2.2 2.8 3.9 2.4 1.2-.3 2-1.4 2-2.7V5.1Zm0 0c.6-1.5 2-2.4 3.5-2.2 1.6.2 2.7 1.5 2.7 3.1 1.6.3 2.7 1.7 2.6 3.3 0 1-.5 1.9-1.3 2.5 1.2.8 1.8 2.2 1.4 3.6-.4 1.4-1.6 2.3-3 2.4-.5 1.8-2.2 2.8-3.9 2.4-1.2-.3-2-1.4-2-2.7V5.1Z"
                />
                <path className="brain-shadow" d="M3.4 14.2c1.1.4 2.2.2 3-.5-.2 1.1.3 2.1 1.2 2.7M20.6 14.2c-1.1.4-2.2.2-3-.5.2 1.1-.3 2.1-1.2 2.7M12 5.3v12.2" />
                <path className="brain-fold" d="M6 6.2c1 .1 1.8.8 2 1.7M4.4 10.1c1.1-.5 2.3-.2 3 .7M8.1 11.3c.9.5 1.3 1.4 1 2.4M18 6.2c-1 .1-1.8.8-2 1.7m3.6 2.2c-1.1-.5-2.3-.2-3 .7m-.7.5c-.9.5-1.3 1.4-1 2.4" />
                <path className="brain-highlight" d="M7.1 4.9c.6-.8 1.6-1.1 2.4-.7M4.8 13.1c-.6.5-.7 1.3-.4 2" />
              </svg>
            </div>
            <span className="brand-name">Agent Center</span>
            <button
              className="icon-button theme-toggle ms-auto"
              aria-label={`Theme: ${themeMode}. Switch to ${nextThemeMode(themeMode)} theme`}
              title={`Theme: ${themeMode}`}
              onClick={() => setThemeMode((current) => nextThemeMode(current))}
            >
              <i className={`bi ${themeIcon(themeMode)}`} />
            </button>
            <button className="icon-button d-lg-none" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}>
              <i className="bi bi-x-lg" />
            </button>
          </div>
          <div className="new-task-row">
            <button className="new-task-button" onClick={showNewTaskPicker} disabled={connectionState !== "connected"} aria-expanded={newTaskOpen}>
              <i className="bi bi-plus-lg" />
              <span>New task</span>
            </button>
            <button
              className="open-directory-button"
              onClick={showDirectoryPicker}
              disabled={connectionState === "connecting"}
              aria-label="Open another project directory"
              aria-expanded={directoryOpen}
              title="Open directory"
            >
              <i className="bi bi-folder2-open" aria-hidden="true" />
            </button>
          </div>
          {newTaskOpen && (
            <form className="directory-picker new-task-picker" onSubmit={handleNewSessionSubmit}>
              <div className="directory-picker-heading">
                <span>New task</span>
                <button type="button" className="icon-button" aria-label="Close new task picker" onClick={() => setNewTaskOpen(false)}>
                  <i className="bi bi-x" aria-hidden="true" />
                </button>
              </div>
              {recentDirectories.length > 0 && (
                <div className="recent-projects" aria-label="Recent projects">
                  <span>Recent projects</span>
                  {recentDirectories.slice(0, 5).map((recentDirectory) => (
                    <button type="button" onClick={() => void handleNewSession(recentDirectory)} disabled={creatingSession} key={recentDirectory}>
                      <i className="bi bi-folder2" aria-hidden="true" />
                      <span><strong>{basename(recentDirectory)}</strong><small>{recentDirectory}</small></span>
                    </button>
                  ))}
                </div>
              )}
              <label htmlFor="new-task-directory">Project path</label>
              <input
                id="new-task-directory"
                autoFocus
                list="known-project-directories"
                value={newTaskDirectory}
                onChange={(event) => { setNewTaskDirectory(event.target.value); setNewTaskError(""); }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setNewTaskOpen(false);
                  }
                }}
                placeholder="/path/to/project"
                aria-invalid={Boolean(newTaskError)}
                disabled={creatingSession}
              />
              <datalist id="known-project-directories">
                {knownDirectories.map((knownDirectory) => <option value={knownDirectory} key={knownDirectory} />)}
              </datalist>
              {newTaskError && <div className="new-task-error" role="alert">{newTaskError}</div>}
              <div className="directory-picker-actions justify-content-end">
                <button type="submit" disabled={creatingSession}>{creatingSession ? "Creating…" : "Create task"}</button>
              </div>
            </form>
          )}
          {directoryOpen && (
            <form className="directory-picker" onSubmit={handleOpenDirectory}>
              <div className="directory-picker-heading">
                <span>Open directory</span>
                <button type="button" className="icon-button" aria-label="Close directory picker" onClick={() => setDirectoryOpen(false)}>
                  <i className="bi bi-x" aria-hidden="true" />
                </button>
              </div>
              {recentDirectories.length > 0 && (
                <div className="recent-projects open-directory-projects" aria-label="Recent projects">
                  <span>Recent projects</span>
                  <div className="recent-project-list">
                    {recentDirectories.slice(0, 20).map((recentDirectory) => (
                      <button
                        type="button"
                        onClick={() => void openDirectory(recentDirectory)}
                        disabled={connectionState === "connecting"}
                        title={recentDirectory}
                        key={recentDirectory}
                      >
                        <i className="bi bi-folder2" aria-hidden="true" />
                        <span><strong>{basename(recentDirectory)}</strong><small>{recentDirectory}</small></span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label htmlFor="directory-path">Project path</label>
              <input
                id="directory-path"
                autoFocus
                list="known-project-directories"
                value={directoryDraft}
                onChange={(event) => setDirectoryDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDirectoryOpen(false);
                  }
                }}
                placeholder="/path/to/project"
              />
              <datalist id="known-project-directories">
                {knownDirectories.map((knownDirectory) => <option value={knownDirectory} key={knownDirectory} />)}
              </datalist>
              <div className="directory-picker-actions">
                <button type="button" onClick={() => setDirectoryDraft("")}>All projects</button>
                <button type="submit">Open</button>
              </div>
            </form>
          )}
          <label className="thread-search">
            <i className="bi bi-search" aria-hidden="true" />
            <span className="visually-hidden">Search threads</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" />
          </label>
          <div className="group-switch" role="group" aria-label="Group tasks by">
            <button aria-pressed={groupMode === "date"} onClick={() => setGroupMode("date")}>
              <i className="bi bi-calendar3" aria-hidden="true" /> Date
            </button>
            <button aria-pressed={groupMode === "project"} onClick={() => setGroupMode("project")}>
              <i className="bi bi-folder2" aria-hidden="true" /> Project
            </button>
          </div>
        </div>

        <nav className="thread-list" aria-label="Recent tasks">
          {groupedSessions.pinned.length > 0 && (
            <section className="thread-group pinned-group">
              <h2><i className="bi bi-pin-angle-fill" aria-hidden="true" /> Pinned</h2>
              {groupedSessions.pinned.map((session) => renderSessionTree(session, true))}
            </section>
          )}
          {groupedSessions.groups.map((group) => (
            <section className={`thread-group ${groupMode === "project" ? "project-group" : ""}`} key={group.key}>
              <h2 title={groupMode === "project" ? group.key : undefined}>{group.label}</h2>
              {group.items.map((session) => renderSessionTree(session, false))}
            </section>
          ))}
          {groupedSessions.pinned.length === 0 && groupedSessions.groups.length === 0 && (
            <div className="sidebar-empty">
              {search
                ? `No tasks match “${search}”.`
                : connectionState === "connecting"
                  ? "Loading tasks…"
                  : connectionState === "error"
                    ? "Connect to load tasks."
                    : "No tasks yet."}
            </div>
          )}
        </nav>

        <div className="connection-area">
          {connectionOpen && (
            <form className="connection-form" onSubmit={handleConnect}>
              <div className="connection-form-heading">
                <span>Connect OpenCode</span>
                <button type="button" className="icon-button" aria-label="Close connection form" onClick={() => setConnectionOpen(false)}>
                  <i className="bi bi-x" />
                </button>
              </div>
              <label>
                Server URL
                <input required value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder={DEFAULT_URL} />
              </label>
              <label>
                Project directory <span>optional</span>
                <input value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/path/to/project" />
              </label>
              <label>
                Server password <span>optional</span>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              </label>
              {connectionError && <div className="connection-error" role="alert">{connectionError}</div>}
              <button className="connect-submit" disabled={connectionState === "connecting"}>
                {connectionState === "connecting" ? "Connecting…" : "Connect"}
              </button>
            </form>
          )}
          <button className="connection-summary" onClick={() => setConnectionOpen((open) => !open)} aria-expanded={connectionOpen}>
            <span className={`status-dot status-${connectionState}`} />
            <span className="connection-copy">
              <strong>{connectionState === "connected" ? "OpenCode connected" : connectionState === "error" ? "OpenCode unavailable" : "Connecting to OpenCode"}</strong>
              <small>{connectionState === "connected" ? connection?.options.baseUrl : serverUrl}</small>
            </span>
            <i className="bi bi-chevron-up" />
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <button className="icon-button d-lg-none" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <i className="bi bi-layout-sidebar" />
          </button>
          <div className={`task-heading ${activeParentSession ? "is-subagent-heading" : ""}`}>
            {activeParentSession && (
              <>
                <button className="parent-task-link" onClick={() => void selectSession(activeParentSession)} title={activeParentSession.title}>
                  {activeParentSession.title}
                </button>
                <i className="bi bi-chevron-right task-divider" aria-hidden="true" />
              </>
            )}
            <h1>{activeSession ? activeParentSession ? subagentTitle(activeSession.title) : activeSession.title : "Agent Center"}</h1>
            {activeParentSession
              ? <span className="subagent-badge">@{subagentName(activeSession.title)}</span>
              : activeSession && <span className="task-path">{activeSession.directory}</span>}
          </div>
          {activeSession && !activeSession.parentID && (
            <button
              className={`header-action ${pinnedSessionIDs.includes(activeSession.id) ? "is-pinned" : ""}`}
              title={pinnedSessionIDs.includes(activeSession.id) ? "Unpin task" : "Pin task"}
              aria-label={pinnedSessionIDs.includes(activeSession.id) ? "Unpin current task" : "Pin current task"}
              aria-pressed={pinnedSessionIDs.includes(activeSession.id)}
              onClick={() => togglePinned(activeSession.id)}
            >
              <i className={`bi ${pinnedSessionIDs.includes(activeSession.id) ? "bi-pin-angle-fill" : "bi-pin-angle"}`} />
            </button>
          )}
        </header>

        <section className="conversation" aria-label="Task conversation">
          <div className="conversation-inner">
            {connectionState === "connecting" ? (
              <div className="connection-state" role="status">
                <span className="connection-spinner" aria-hidden="true" />
                <h2>Connecting to OpenCode</h2>
                <p>{serverUrl}</p>
              </div>
            ) : connectionState === "error" ? (
              <div className="connection-state connection-state-error" role="alert">
                <div className="connection-state-icon"><i className="bi bi-plug" /></div>
                <h2>OpenCode is unavailable</h2>
                <p>{connectionError}</p>
                <div className="connection-state-actions">
                  <button onClick={() => void connectToServer(serverUrl, directory, password)}>Retry</button>
                  <button onClick={() => setConnectionOpen(true)}>Connection settings</button>
                </div>
              </div>
            ) : loadingMessages ? (
              <div className="message-skeleton" aria-label="Loading messages">
                <span /><span /><span />
              </div>
            ) : !activeSession ? (
              <div className="empty-conversation">
                <div className="empty-symbol"><i className="bi bi-plus-lg" /></div>
                <h2>Start your first task</h2>
                <p>This server has no sessions for the selected project directory.</p>
                <div className="prompt-suggestions">
                  <button onClick={() => { showNewTaskPicker(); setSidebarOpen(true); }}>New task</button>
                </div>
              </div>
            ) : activeMessages.length > 0 ? (
              conversationTurns.map((message) => <Message key={message.id} message={message} />)
            ) : (
              <div className="empty-conversation">
                <div className="empty-symbol"><i className="bi bi-command" /></div>
                <h2>What should the agent work on?</h2>
                <p>Describe a change, ask for an investigation, or point it at a failing test.</p>
                <div className="prompt-suggestions">
                  <button onClick={() => setDraft("Review this project and identify the highest-impact improvement.")}>Review this project</button>
                  <button onClick={() => setDraft("Run the test suite and fix the first failure.")}>Fix a failing test</button>
                  <button onClick={() => setDraft("Explain the architecture of this codebase.")}>Explain the architecture</button>
                </div>
              </div>
            )}
            {activeSubagents.length > 0 && (
              <details className="conversation-subagents" open key={activeSession?.id}>
                <summary>
                  <span className="conversation-subagents-heading">
                    <i className="bi bi-diagram-2" aria-hidden="true" />
                    Subagents
                  </span>
                  <span className="conversation-subagents-count">{activeSubagents.length}</span>
                  <i className="bi bi-chevron-down conversation-subagents-chevron" aria-hidden="true" />
                </summary>
                <div className="conversation-subagent-list">
                  {activeSubagents.map((subagent) => {
                    const { busy: isBusy, unread: isUnread } = sessionActivity(subagent);
                    const nestedCount = (childSessionsByParent[subagent.id] || []).length;
                    return (
                      <button
                        className="conversation-subagent-open"
                        key={subagent.id}
                        onClick={() => void selectSession(subagent)}
                        aria-label={`View subagent: ${subagentTitle(subagent.title)}${isBusy ? ", task in progress" : isUnread ? ", unread" : ""}`}
                        title={subagent.title}
                      >
                        <span className="conversation-subagent-leading">
                          {isBusy || isUnread ? (
                            <span
                              className={`conversation-subagent-indicator ${isBusy ? "is-busy" : "is-unread"}`}
                              title={isBusy ? "Task in progress" : "Unread task"}
                            >
                              <span className="visually-hidden">{isBusy ? "Task in progress" : "Unread task"}</span>
                            </span>
                          ) : (
                            <i className="bi bi-diagram-2 conversation-subagent-icon" aria-hidden="true" />
                          )}
                        </span>
                        <span className="conversation-subagent-copy">
                          <strong>{subagentTitle(subagent.title)}</strong>
                          <small>@{subagentName(subagent.title)}{nestedCount > 0 ? ` · ${nestedCount} nested` : ""}</small>
                        </span>
                        <time>{timeLabel(subagent.time.updated)}</time>
                        <i className="bi bi-chevron-right conversation-subagent-arrow" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </details>
            )}
            {activeSessionIsBusy && (
              <div className="agent-working" role="status">
                <span className="working-indicator"><span /><span /><span /></span>
                {stoppingSessionID === activeSession?.id ? "Stopping OpenCode" : "OpenCode is working"}
              </div>
            )}
            <div ref={endRef} />
          </div>
        </section>

        <footer className="composer-wrap">
          {activeTodos.length > 0 && <TodoPanel key={activeSession?.id} todos={activeTodos} />}
          {activeParentSession ? (
            <div className="subagent-view-bar">
              <span><i className="bi bi-diagram-2" aria-hidden="true" /> Viewing subagent session</span>
              <button onClick={() => void selectSession(activeParentSession)}>
                <i className="bi bi-arrow-left" aria-hidden="true" /> Parent task
              </button>
            </div>
          ) : (
          <>
            {connectionError && !connectionOpen && (
              <button className="inline-error" onClick={() => setConnectionOpen(true)}>
                <i className="bi bi-exclamation-circle" /> {connectionError}
              </button>
            )}
            <div className="composer">
            {attachments.length > 0 && (
              <div className="attachment-list" aria-label="Attached files">
                {attachments.map((file) => (
                  <span className="attachment-chip" key={file.id}>
                    <i className={`bi ${file.mime.startsWith("image/") ? "bi-image" : "bi-file-earmark"}`} aria-hidden="true" />
                    <span className="attachment-name">{file.name}</span>
                    <small>{fileSizeLabel(file.size)}</small>
                    <button onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))} aria-label={`Remove ${file.name}`}>
                      <i className="bi bi-x" aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {composerError && <div className="composer-error" role="alert">{composerError}</div>}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              disabled={connectionState !== "connected" || !activeSession}
              rows={1}
              placeholder={connectionState === "connected" ? "Ask OpenCode to build, investigate, or fix…" : "Connect to OpenCode to begin"}
              aria-label="Prompt"
            />
            <div className="composer-toolbar">
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                className="visually-hidden"
                onChange={handleAttachments}
                tabIndex={-1}
              />
              <button className="attach-button" onClick={() => attachmentInputRef.current?.click()} disabled={connectionState !== "connected" || !activeSession} aria-label="Attach files" title="Attach files">
                <i className="bi bi-paperclip" />
              </button>
              <div className="agent-control" ref={agentControlRef}>
                {agentMenuOpen && (
                  <div className="agent-menu" role="menu" aria-label="Choose agent">
                    {agents.map((agent) => (
                      <button
                        key={agent.name}
                        role="menuitemradio"
                        aria-checked={agent.name === selectedAgent}
                        onClick={() => { setSelectedAgent(agent.name); setAgentMenuOpen(false); }}
                      >
                        <span className="agent-menu-icon"><i className={`bi ${agent.name === selectedAgent ? "bi-check2" : "bi-command"}`} /></span>
                        <span><strong>{displayAgentName(agent.name)}</strong><small>{agent.description || `${agent.mode} agent`}</small></span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="agent-selector"
                  onClick={() => { setAgentMenuOpen((open) => !open); setModelMenuOpen(false); }}
                  disabled={connectionState !== "connected" || agents.length === 0}
                  aria-haspopup="menu"
                  aria-expanded={agentMenuOpen}
                >
                  <i className="bi bi-terminal" /> {selectedAgent ? displayAgentName(selectedAgent) : "Agent"} <i className="bi bi-chevron-down" />
                </button>
              </div>
              <div className="model-control" ref={modelControlRef}>
                {modelMenuOpen && (
                  <div className="model-menu" role="dialog" aria-label="Choose model">
                    <label className="model-search">
                      <i className="bi bi-search" aria-hidden="true" />
                      <input
                        autoFocus
                        value={modelSearch}
                        onChange={(event) => setModelSearch(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setModelMenuOpen(false);
                            setModelSearch("");
                          }
                        }}
                        placeholder="Search models"
                        aria-label="Search models"
                      />
                    </label>
                    <div className="model-options" role="listbox" aria-label="Available models">
                      <button
                        className="model-option"
                        role="option"
                        aria-selected={!selectedModel}
                        onClick={() => { setSelectedModel(null); setModelMenuOpen(false); setModelSearch(""); }}
                      >
                        <span className="model-option-icon"><i className={!selectedModel ? "bi bi-check2" : "bi bi-stars"} /></span>
                        <span>
                          <strong>{automaticModel?.name || "OpenCode model"}</strong>
                          <small>{automaticModel ? `${automaticModel.providerName} · Automatic` : "Use the server configuration"}</small>
                        </span>
                      </button>
                      {filteredModels.map((model) => {
                        const selected = selectedModel?.providerID === model.providerID && selectedModel.modelID === model.modelID;
                        return (
                          <button
                            className="model-option"
                            role="option"
                            aria-selected={selected}
                            key={`${model.providerID}/${model.modelID}`}
                            onClick={() => { setSelectedModel(model); setModelMenuOpen(false); setModelSearch(""); }}
                          >
                            <span className="model-option-icon"><i className={selected ? "bi bi-check2" : "bi bi-cpu"} /></span>
                            <span>
                              <strong>{model.name}</strong>
                              <small>{model.providerName}{model.isDefault ? " · Provider default" : ""}</small>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="model-menu-footnote">
                      {modelSearch ? `${Math.min(filteredModels.length, 80)} matching models` : `${models.length} models from connected providers`}
                    </div>
                  </div>
                )}
                <button
                  className="model-selector"
                  onClick={() => { setModelMenuOpen((open) => !open); setAgentMenuOpen(false); }}
                  disabled={connectionState !== "connected"}
                  aria-haspopup="dialog"
                  aria-expanded={modelMenuOpen}
                  aria-label={`Choose model, currently ${displayedModel?.name || "OpenCode model"}`}
                  title={displayedModel ? `${displayedModel.providerName} / ${displayedModel.modelID}${selectedModel ? "" : " · Automatic"}` : "Use the server configuration"}
                >
                  <i className="bi bi-cpu" />
                  <span>{displayedModel?.name || "OpenCode model"}</span>
                  <i className="bi bi-chevron-down" />
                </button>
              </div>
              {activeSessionIsBusy ? (
                <button
                  className="stop-button"
                  onClick={() => void handleStop()}
                  disabled={stoppingSessionID === activeSession?.id}
                  aria-label={stoppingSessionID === activeSession?.id ? "Stopping agent" : "Stop agent"}
                  title={stoppingSessionID === activeSession?.id ? "Stopping agent" : "Stop agent"}
                >
                  <i className={`bi ${stoppingSessionID === activeSession?.id ? "bi-hourglass-split" : "bi-stop-fill"}`} />
                </button>
              ) : (
                <button className="send-button" onClick={() => void handleSend()} disabled={connectionState !== "connected" || !activeSession || (!draft.trim() && attachments.length === 0)} aria-label="Send prompt">
                  <i className="bi bi-arrow-up" />
                </button>
              )}
            </div>
            </div>
          </>
          )}
        </footer>
      </main>
    </div>
  );
}
