import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(name: string, level?: string): Logger {
  const resolvedLevel = process.env.LOG_LEVEL ?? level ?? "info";
  const isDev = process.env.NODE_ENV === "development";

  const transport = isDev
    ? pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      })
    : undefined;

  return pino({
    level: resolvedLevel,
    base: { service: "lucent-connector-sdk", component: name },
  }, transport);
}

