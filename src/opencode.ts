import {
  createOpencodeClient,
  type Agent,
  type FilePartInput,
  type OpencodeClient,
  type Part,
  type Session,
  type SessionStatus,
} from "@opencode-ai/sdk/client";

export type ConnectionOptions = {
  baseUrl: string;
  directory?: string;
  username?: string;
  password?: string;
};

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant";
  created: number;
  completed?: number;
  agent?: string;
  provider?: string;
  model?: string;
  error?: string;
  parts: Part[];
};

export type OpenCodeConnection = {
  client: OpencodeClient;
  options: ConnectionOptions;
};

export type AgentOption = Pick<Agent, "name" | "description" | "mode" | "builtIn" | "model">;

export type ModelOption = {
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  isDefault: boolean;
};

export type RecentModelUsage = Pick<ModelOption, "providerID" | "modelID"> & {
  uses: number;
  lastUsed: number;
};

export type PromptAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
};

function basicAuth(username: string, password: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return `Basic ${btoa(binary)}`;
}

export function createConnection(options: ConnectionOptions): OpenCodeConnection {
  const baseUrl = options.baseUrl.trim().replace(/\/$/, "");
  const headers = options.password
    ? { Authorization: basicAuth(options.username || "opencode", options.password) }
    : undefined;

  return {
    options: { ...options, baseUrl },
    client: createOpencodeClient({
      baseUrl,
      directory: options.directory?.trim() || undefined,
      headers,
      throwOnError: true,
    }),
  };
}

function withoutDirectory(connection: OpenCodeConnection) {
  return connection.options.directory
    ? createConnection({ ...connection.options, directory: undefined })
    : connection;
}

async function listProjects(connection: OpenCodeConnection) {
  const response = await withoutDirectory(connection).client.project.list({ throwOnError: true });
  return response.data.filter((project) => project.id !== "global" && project.worktree !== "/");
}

async function listSessionsForDirectory(connection: OpenCodeConnection, directory: string): Promise<Session[]> {
  const scoped = createConnection({ ...connection.options, directory });
  const response = await scoped.client.session.list({
    query: { directory },
    throwOnError: true,
  });
  return response.data;
}

export async function listSessions(connection: OpenCodeConnection): Promise<Session[]> {
  let projectDirectories: string[];
  try {
    projectDirectories = (await listProjects(connection)).map((project) => project.worktree);
  } catch {
    projectDirectories = [];
  }

  const directories = Array.from(new Set([
    connection.options.directory,
    ...projectDirectories,
  ].filter((directory): directory is string => Boolean(directory?.trim()))));

  if (directories.length === 0) {
    const response = await connection.client.session.list({
      query: { directory: connection.options.directory || undefined },
      throwOnError: true,
    });
    return response.data.sort((a, b) => b.time.updated - a.time.updated);
  }

  const results = await Promise.allSettled(
    directories.map((directory) => listSessionsForDirectory(connection, directory)),
  );
  const sessions = new Map<string, Session>();
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      result.value.forEach((session) => sessions.set(session.id, session));
    }
  });

  if (sessions.size === 0 && results.every((result) => result.status === "rejected")) {
    throw results[0].reason;
  }

  return Array.from(sessions.values()).sort((a, b) => b.time.updated - a.time.updated);
}

export async function listRecentProjectDirectories(connection: OpenCodeConnection): Promise<string[]> {
  const [sessionsResult, projectsResult] = await Promise.allSettled([
    listSessions(connection),
    listProjects(connection),
  ]);
  const latestByDirectory = new Map<string, number>();

  if (sessionsResult.status === "fulfilled") {
    sessionsResult.value.forEach((session) => {
      latestByDirectory.set(
        session.directory,
        Math.max(latestByDirectory.get(session.directory) || 0, session.time.updated),
      );
    });
  }

  if (projectsResult.status === "fulfilled") {
    projectsResult.value.forEach((project) => {
      const time = project.time as typeof project.time & { updated?: number };
      const activity = time.updated || time.initialized || time.created;
      latestByDirectory.set(project.worktree, Math.max(latestByDirectory.get(project.worktree) || 0, activity));
    });
  }

  if (connection.options.directory && !latestByDirectory.has(connection.options.directory)) {
    latestByDirectory.set(connection.options.directory, Date.now());
  }

  return Array.from(latestByDirectory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([directory]) => directory);
}

export async function listSessionStatuses(
  connection: OpenCodeConnection,
  directories: string[] = [],
): Promise<Record<string, SessionStatus>> {
  const scopes = Array.from(new Set([
    connection.options.directory,
    ...directories,
  ].filter((directory): directory is string => Boolean(directory?.trim()))));

  if (scopes.length === 0) {
    const response = await withoutDirectory(connection).client.session.status({ throwOnError: true });
    return response.data;
  }

  const responses = await Promise.allSettled(scopes.map(async (directory) => {
    const scoped = createConnection({ ...connection.options, directory });
    const response = await scoped.client.session.status({ throwOnError: true });
    return response.data;
  }));

  return responses.reduce<Record<string, SessionStatus>>((statuses, response) => {
    if (response.status === "fulfilled") Object.assign(statuses, response.value);
    return statuses;
  }, {});
}

export async function listAgents(connection: OpenCodeConnection): Promise<AgentOption[]> {
  const response = await connection.client.app.agents({
    query: { directory: connection.options.directory || undefined },
    throwOnError: true,
  });
  return response.data
    .filter((agent) => agent.mode === "primary" || agent.mode === "all")
    .map(({ name, description, mode, builtIn, model }) => ({ name, description, mode, builtIn, model }));
}

export async function listModels(connection: OpenCodeConnection): Promise<ModelOption[]> {
  const response = await connection.client.provider.list({
    query: { directory: connection.options.directory || undefined },
    throwOnError: true,
  });
  const connected = new Set(response.data.connected);
  return response.data.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => Object.values(provider.models)
      .filter((model) =>
        model.status !== "deprecated"
        && model.tool_call !== false
        && (!model.modalities || model.modalities.output.includes("text")),
      )
      .map((model) => ({
        providerID: provider.id,
        providerName: provider.name,
        modelID: model.id,
        name: model.name,
        isDefault: response.data.default[provider.id] === model.id,
      })))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
      || a.providerName.localeCompare(b.providerName)
      || a.name.localeCompare(b.name));
}

export async function createSession(connection: OpenCodeConnection, directory?: string): Promise<Session> {
  const response = await connection.client.session.create({
    body: { title: "New agent task" },
    query: { directory: directory || connection.options.directory || undefined },
    throwOnError: true,
  });
  return response.data;
}

export async function renameSession(
  connection: OpenCodeConnection,
  sessionID: string,
  title: string,
  directory?: string,
): Promise<Session> {
  const response = await connection.client.session.update({
    path: { id: sessionID },
    query: { directory: directory || connection.options.directory || undefined },
    body: { title },
    throwOnError: true,
  });
  return response.data;
}

export async function deleteSession(
  connection: OpenCodeConnection,
  sessionID: string,
  directory?: string,
): Promise<void> {
  await connection.client.session.delete({
    path: { id: sessionID },
    query: { directory: directory || connection.options.directory || undefined },
    throwOnError: true,
  });
}

export async function abortSession(
  connection: OpenCodeConnection,
  sessionID: string,
  directory?: string,
): Promise<void> {
  await connection.client.session.abort({
    path: { id: sessionID },
    query: { directory: directory || connection.options.directory || undefined },
    throwOnError: true,
  });
}

export async function listMessages(
  connection: OpenCodeConnection,
  sessionID: string,
  directory?: string,
): Promise<ThreadMessage[]> {
  const response = await connection.client.session.messages({
    path: { id: sessionID },
    query: { directory: directory || connection.options.directory || undefined },
    throwOnError: true,
  });

  return response.data.map(({ info, parts }) => ({
    id: info.id,
    role: info.role,
    created: info.time.created,
    completed: info.role === "assistant" ? info.time.completed : undefined,
    agent: info.role === "user" ? info.agent : info.mode,
    provider: info.role === "user" ? info.model.providerID : info.providerID,
    model: info.role === "user" ? info.model.modelID : info.modelID,
    error: "error" in info ? sessionErrorMessage(info.error) : undefined,
    parts,
  }));
}

export async function findRecentSuccessfulModel(
  connection: OpenCodeConnection,
): Promise<Pick<ModelOption, "providerID" | "modelID"> | null> {
  try {
    const sessions = (await listSessions(connection))
      .filter((session) => !connection.options.directory || session.directory === connection.options.directory)
      .filter((session) => !session.parentID)
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, 8);
    for (const session of sessions) {
      try {
        const messages = await listMessages(connection, session.id, session.directory);
        const successful = [...messages].reverse().find((message) =>
          message.role === "assistant"
          && !message.error
          && message.provider
          && message.model
          && message.parts.some((part) => part.type === "text" || part.type === "tool"),
        );
        if (successful?.provider && successful.model) {
          return { providerID: successful.provider, modelID: successful.model };
        }
      } catch {
        // A missing or unreadable session should not block new task creation.
      }
    }
  } catch {
    // Fall back to the connected provider defaults when history is unavailable.
  }
  return null;
}

export async function listRecentModelUsage(
  connection: OpenCodeConnection,
  sessions: Session[],
  since = Date.now() - 3 * 24 * 60 * 60 * 1000,
  limit = 12,
): Promise<RecentModelUsage[]> {
  const recentSessions = sessions.filter((session) => session.time.updated >= since);
  const usage = new Map<string, RecentModelUsage>();
  const batchSize = 6;

  for (let offset = 0; offset < recentSessions.length; offset += batchSize) {
    const batch = recentSessions.slice(offset, offset + batchSize);
    const results = await Promise.allSettled(
      batch.map((session) => listMessages(connection, session.id, session.directory)),
    );
    results.forEach((result) => {
      if (result.status !== "fulfilled") return;
      result.value.forEach((message) => {
        if (
          message.role !== "assistant"
          || message.error
          || !message.provider
          || !message.model
          || message.created < since
        ) return;
        const key = `${message.provider}\u0000${message.model}`;
        const current = usage.get(key);
        usage.set(key, {
          providerID: message.provider,
          modelID: message.model,
          uses: (current?.uses || 0) + 1,
          lastUsed: Math.max(current?.lastUsed || 0, message.created),
        });
      });
    });
  }

  return Array.from(usage.values())
    .sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed)
    .slice(0, Math.max(0, limit));
}

function sessionErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (typeof data.message === "string") return data.message;
  }
  return "OpenCode could not complete this response.";
}

export async function sendPrompt(
  connection: OpenCodeConnection,
  sessionID: string,
  text: string,
  agent?: string,
  model?: Pick<ModelOption, "providerID" | "modelID">,
  attachments: PromptAttachment[] = [],
  directory?: string,
): Promise<void> {
  const fileParts: FilePartInput[] = attachments.map((attachment) => ({
    type: "file",
    mime: attachment.mime,
    filename: attachment.name,
    url: attachment.dataUrl,
  }));
  await connection.client.session.prompt({
    path: { id: sessionID },
    query: { directory: directory || connection.options.directory || undefined },
    body: {
      agent,
      model,
      parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
    },
    throwOnError: true,
  });
}
