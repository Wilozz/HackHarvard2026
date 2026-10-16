// Structured logs with ids and metadata only. Never pass message bodies,
// phone numbers, or tokens here.
type Fields = Record<string, string | number | boolean | undefined>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, err: unknown, fields?: Fields) =>
    emit("error", event, {
      ...fields,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }),
};
