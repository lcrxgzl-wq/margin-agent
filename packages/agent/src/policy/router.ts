export type PolicyDecision = {
  route: "host_command" | "pi_session" | "offline_planner";
  matchedRule?: string;
};

export type PolicyInput = {
  message: string;
  hasCredentials: boolean;
  engineEnv?: string;
};

type PolicyRule = {
  name: string;
  matches: (input: PolicyInput) => boolean;
  route: PolicyDecision["route"];
};

function isHostCommand(message: string): boolean {
  const value = message.trim();
  return (
    /^(?:请)?(?:列出|查看|显示)(?:一下)?(?:工作区)?(?:有哪些)?(?:文件|文稿|文章)(?:列表)?[。！？!?]?$/i.test(value) ||
    /^(?:有哪些)(?:文件|文稿|文章)[。！？!?]?$/i.test(value) ||
    /^(?:list(?:\s+files)?|ls)[.!?]?$/i.test(value) ||
    /^(?:请)?打开(?:一下)?(?:样章|文稿|文章|文件|\s+[^\n]+)[。！？!?]?$/i.test(value)
  );
}

/**
 * Full-Pi router: with credentials, every chat turn uses the Pi session shell.
 * Offline only when no Key or MARGIN_ENGINE=simple.
 */
const rules: PolicyRule[] = [
  {
    name: "host-command",
    matches: ({ message }) => isHostCommand(message),
    route: "host_command",
  },
  {
    name: "engine-simple",
    matches: ({ engineEnv }) => engineEnv?.toLowerCase() === "simple",
    route: "offline_planner",
  },
  {
    name: "missing-credentials",
    matches: ({ hasCredentials }) => !hasCredentials,
    route: "offline_planner",
  },
  {
    name: "pi-default",
    matches: () => true,
    route: "pi_session",
  },
];

export function decideRoute(input: PolicyInput): PolicyDecision {
  for (const rule of rules) {
    if (rule.matches(input)) {
      return { route: rule.route, matchedRule: rule.name };
    }
  }
  return { route: "offline_planner", matchedRule: "offline-default" };
}
