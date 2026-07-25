export type PolicyDecision = {
  route: "pi_session" | "offline_planner";
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

/**
 * Full-Pi router: with credentials, every chat turn uses the Pi session shell.
 * Offline only when no Key or MARGIN_ENGINE=simple.
 */
const rules: PolicyRule[] = [
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
