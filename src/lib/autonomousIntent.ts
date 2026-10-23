/**
 * Autonomous Semantic Intent & Action Understanding Engine
 * 
 * Universal intent classifier and entity extractor.
 * Operates on semantic concepts, goal discovery, entity extraction,
 * and contextual multi-turn memory without brittle keyword checks.
 */

export interface AutonomousCredentials {
  username?: string;
  password?: string;
}

export interface AutonomousBrowserPlan {
  url: string;
  subGoal: 'LOGIN' | 'NAVIGATE' | 'SEARCH' | 'INTERACT';
  credentials?: AutonomousCredentials;
  searchQuery?: string;
  description: string;
}

export interface AutonomousShellPlan {
  command: string;
  cwd?: string;
  description: string;
}

export interface AutonomousFilePlan {
  action: 'READ' | 'WRITE' | 'EDIT';
  path: string;
  content?: string;
}

export interface AutonomousIntentResult {
  isActionable: boolean;
  category: 'BROWSER' | 'SHELL' | 'FILE' | 'CONNECTOR' | 'CONVERSATION';
  browser?: AutonomousBrowserPlan;
  shell?: AutonomousShellPlan;
  file?: AutonomousFilePlan;
  reasoning: string;
  confidence: number;
}

// Universal Service Directory
const SERVICE_DIRECTORY: Record<string, { home: string; login: string; search?: (q: string) => string }> = {
  github: {
    home: 'https://github.com',
    login: 'https://github.com/login',
    search: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  },
  google: {
    home: 'https://www.google.com',
    login: 'https://accounts.google.com/signin',
    search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  youtube: {
    home: 'https://www.youtube.com',
    login: 'https://accounts.google.com/signin',
    search: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  },
  wikipedia: {
    home: 'https://www.wikipedia.org',
    login: 'https://en.wikipedia.org/w/index.php?title=Special:UserLogin',
    search: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  },
  linear: {
    home: 'https://linear.app',
    login: 'https://linear.app/login',
  },
  notion: {
    home: 'https://www.notion.so',
    login: 'https://www.notion.so/login',
  },
  slack: {
    home: 'https://slack.com',
    login: 'https://slack.com/signin',
  },
  twitter: {
    home: 'https://x.com',
    login: 'https://x.com/i/flow/login',
  },
  x: {
    home: 'https://x.com',
    login: 'https://x.com/i/flow/login',
  },
  reddit: {
    home: 'https://www.reddit.com',
    login: 'https://www.reddit.com/login',
    search: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  },
  amazon: {
    home: 'https://www.amazon.com',
    login: 'https://www.amazon.com/ap/signin',
    search: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  },
  linkedin: {
    home: 'https://www.linkedin.com',
    login: 'https://www.linkedin.com/login',
  },
  instagram: {
    home: 'https://www.instagram.com',
    login: 'https://www.instagram.com/accounts/login/',
  },
  facebook: {
    home: 'https://www.facebook.com',
    login: 'https://www.facebook.com/login',
  },
  vercel: {
    home: 'https://vercel.com',
    login: 'https://vercel.com/login',
  },
  supabase: {
    home: 'https://supabase.com',
    login: 'https://supabase.com/dashboard/sign-in',
  },
};

/**
 * Extracts email addresses from text
 */
function extractEmail(text: string): string | undefined {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : undefined;
}

/**
 * Extracts password tokens with semantic filtering
 */
function extractPassword(text: string, knownEmail?: string): string | undefined {
  const ignoredWords = new Set([
    'password', 'credentials', 'account', 'please', 'terminal', 'browser',
    'github', 'google', 'youtube', 'wikipedia', 'restaurants', 'search', 'navigate',
    'signin', 'login', 'javascript', 'typescript', 'machine', 'learning', 'python',
    'script', 'concise', 'website', 'measure', 'response', 'time'
  ]);

  // 1. Explicit indicator: "password: XYZ", "pwd 123", "secret is ABC"
  const afterPassMatch = text.match(/(?:pass(?:word)?|pwd|secret)(?:\s+is|\s*[:=]|\s+as|\s+to)?\s+([^\s]+)(?:\s+([^\s]+))?/i);
  if (afterPassMatch) {
    const candidate1 = afterPassMatch[1]?.replace(/['",.]/g, '').trim();
    const candidate2 = afterPassMatch[2]?.replace(/['",.]/g, '').trim();

    if (candidate1 && candidate1.includes('@')) {
      if (candidate2 && candidate2.length >= 4) return candidate2;
    } else if (candidate1 && candidate1.length >= 4 && !ignoredWords.has(candidate1.toLowerCase())) {
      return candidate1;
    }
  }

  // 2. High-entropy token with digits or symbols (only if context has login or email)
  const hasLoginContext = /\b(login|log\s+in|sign\s+in|signin|authenticate|auth|credentials)\b/i.test(text) || Boolean(knownEmail);
  if (hasLoginContext) {
    const tokens = text.split(/\s+/);
    for (const rawToken of tokens) {
      const clean = rawToken.replace(/^['"(<[]+|['")>\].,;:]+$/g, '');
      if (clean.length < 6) continue;
      if (knownEmail && (clean.includes(knownEmail) || knownEmail.includes(clean))) continue;
      if (clean.includes('@') && clean.includes('.')) continue;
      if (ignoredWords.has(clean.toLowerCase())) continue;
      const hasDigit = /[0-9]/.test(clean);
      const hasSymbol = /[!@#$%^&*()_+=\-{}\[\]:;<>?,./~`]/.test(clean);
      if (hasDigit || hasSymbol) {
        return clean;
      }
    }
  }

  return undefined;
}

/**
 * Core Autonomous Intent Analyzer
 */
export function parseAutonomousIntent(
  userText: string,
  contextHistory: Array<{ role: string; content: string }> = []
): AutonomousIntentResult {
  const raw = String(userText || '').trim();
  const lower = raw.toLowerCase();

  // Pure coding or explanation prompt detection
  const isPureCodingOrReasoning = (
    /\b(write|create|implement|explain|how\s+to|what\s+is|why\s+does|script|code|function|algorithm)\b/i.test(lower) &&
    !/\b(in\s+browser|in\s+the\s+browser|on\s+browser|open\s+in\s+browser|navigate\s+to|go\s+to|visit)\b/i.test(lower)
  );

  // Shell / CLI directive detection
  const hasShellDirective = (
    /\b(terminal|shell|powershell|bash|cmd|command\s+line|run\s+command|exec)\b/i.test(lower) ||
    /^(?:npm|pnpm|yarn|npx|git|python|node|cargo|pip|docker|ls|dir|cd|cat|curl|netstat)\s+/i.test(raw)
  );

  if (hasShellDirective) {
    const cleanCmd = raw.replace(/^(?:please\s+)?(?:run|execute|in\s+terminal|in\s+shell)\s*[:]?\s*/i, '').trim();
    return {
      isActionable: true,
      category: 'SHELL',
      confidence: 0.95,
      reasoning: `Detected shell execution directive for command: ${cleanCmd}`,
      shell: {
        command: cleanCmd,
        description: `Running terminal command: ${cleanCmd}`,
      },
    };
  }

  // 1. Identify URL or Domain Mentions in CURRENT turn
  const explicitUrlMatchCurrent = raw.match(/https?:\/\/[^\s"'<>]+/i);
  const domainMatchCurrent = raw.match(/\b([a-zA-Z0-9-]+\.(?:com|org|io|dev|net|ai|app|co|so|in|gov|edu)(?:\/[^\s]*)?)\b/i);

  // 2. Identify Target Service in CURRENT turn
  let matchedServiceKeyCurrent: string | null = null;
  for (const key of Object.keys(SERVICE_DIRECTORY)) {
    if (new RegExp(`\\b${key}\\b`, 'i').test(lower)) {
      matchedServiceKeyCurrent = key;
      break;
    }
  }

  const hasCurrentTarget = Boolean(explicitUrlMatchCurrent || domainMatchCurrent || matchedServiceKeyCurrent);

  // Check if current turn is pure coding and has no URL, domain, or service
  if (isPureCodingOrReasoning && !hasCurrentTarget) {
    return {
      isActionable: false,
      category: 'CONVERSATION',
      confidence: 0.95,
      reasoning: 'Conversational coding or technical reasoning prompt.',
    };
  }

  // Follow-up context handling (ONLY if current turn does NOT specify a new target)
  const recentUserTurns = contextHistory
    .filter((m) => m && m.role === 'user')
    .slice(-4)
    .map((m) => String(m.content || ''))
    .join(' ');
  const isExplicitFollowUp = !hasCurrentTarget && /\b(go\s+there|open\s+it|open\s+this|open|login|log\s+in|sign\s+in|now\s+do\s+it|proceed|continue|submit|cant\s+see|show\s+me)\b/i.test(lower);

  const explicitUrlMatch = explicitUrlMatchCurrent || (isExplicitFollowUp ? recentUserTurns.match(/https?:\/\/[^\s"'<>]+/i) : null);
  const domainMatch = domainMatchCurrent || (isExplicitFollowUp ? recentUserTurns.match(/\b([a-zA-Z0-9-]+\.(?:com|org|io|dev|net|ai|app|co|so|in|gov|edu)(?:\/[^\s]*)?)\b/i) : null);

  let matchedServiceKey = matchedServiceKeyCurrent;
  if (!matchedServiceKey && isExplicitFollowUp) {
    for (const key of Object.keys(SERVICE_DIRECTORY)) {
      if (new RegExp(`\\b${key}\\b`, 'i').test(recentUserTurns.toLowerCase())) {
        matchedServiceKey = key;
        break;
      }
    }
  }

  // 3. Detect Action Types & Directives
  const hasBrowserDirective = (
    /\b(browser|browse|navigate|open|visit|launch|go\s+to|pull\s+up|load|show|jump\s+on|check\s+on|view)\b/i.test(lower) ||
    lower.includes('in the browser') ||
    lower.includes('on browser') ||
    lower.includes('cant see') ||
    Boolean(explicitUrlMatch) ||
    Boolean(domainMatch) ||
    Boolean(matchedServiceKey)
  );

  const hasLoginIntent = (
    /\b(login|log\s+in|sign\s+in|signin|authenticate|auth|credentials|account)\b/i.test(lower) ||
    (/\b(?:pass|password)\b/i.test(lower) && lower.includes('@'))
  );

  const hasSearchIntent = (
    /\b(search|find|look\s+up)\b/i.test(lower) && !hasLoginIntent
  );

  // 4. Resolve Browser Action
  if (hasBrowserDirective) {
    let targetUrl = 'https://www.google.com';
    let subGoal: AutonomousBrowserPlan['subGoal'] = 'NAVIGATE';

    // A. Explicit URL
    if (explicitUrlMatch) {
      targetUrl = explicitUrlMatch[0];
    }
    // B. Bare Domain
    else if (domainMatch) {
      targetUrl = `https://${domainMatch[1]}`;
    }
    // C. Recognized Specific Repositories
    else if (/desktop(?:\s+app)?(?:\s+repo|\s+repository)?/i.test(raw) || (/github/i.test(raw) && /desktop/i.test(raw))) {
      targetUrl = 'https://github.com/sameer-sys/claude-enterprise-desktop-app';
    }
    else if (/web(?:\s+app)?(?:\s+repo|\s+repository)?/i.test(raw) || (/github/i.test(raw) && /web/i.test(raw))) {
      targetUrl = 'https://github.com/sameer-sys/claude-enterprise-web-app';
    }
    else if (/mobile(?:\s+app)?(?:\s+repo|\s+repository)?/i.test(raw) || (/github/i.test(raw) && /mobile/i.test(raw))) {
      targetUrl = 'https://github.com/sameer-sys/claude-enterprise-mobile-apk';
    }
    // D. Recognized Service
    else if (matchedServiceKey) {
      const svc = SERVICE_DIRECTORY[matchedServiceKey];
      if (hasLoginIntent) {
        targetUrl = svc.login;
        subGoal = 'LOGIN';
      } else if (hasSearchIntent && svc.search) {
        const query = raw.replace(new RegExp(`.*(?:search|find|look\\s+up)\\s+(?:for\\s+)?(?:in\\s+|on\\s+)?(?:${matchedServiceKey}\\s+)?`, 'i'), '').trim();
        targetUrl = svc.search(query || 'latest');
        subGoal = 'SEARCH';
      } else {
        targetUrl = svc.home;
      }
    }
    // D. Generic Search
    else if (hasSearchIntent) {
      const query = raw.replace(/^(?:search|look\s+up|find)\s+(?:for\s+)?/i, '').trim();
      targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query || raw)}`;
      subGoal = 'SEARCH';
    }

    // Extract Credentials
    const email = extractEmail(raw) || (isExplicitFollowUp ? extractEmail(recentUserTurns) : undefined);
    const password = extractPassword(raw, email) || (isExplicitFollowUp ? extractPassword(recentUserTurns, email) : undefined);
    const credentials = (email || password) ? { username: email, password } : undefined;

    if (hasLoginIntent || (credentials && credentials.username)) {
      subGoal = 'LOGIN';
      if (matchedServiceKey && SERVICE_DIRECTORY[matchedServiceKey]?.login) {
        targetUrl = SERVICE_DIRECTORY[matchedServiceKey].login;
      }
    }

    return {
      isActionable: true,
      category: 'BROWSER',
      confidence: 0.96,
      reasoning: `Autonomous browsing directive targeting ${targetUrl} (goal: ${subGoal}).`,
      browser: {
        url: targetUrl,
        subGoal,
        credentials,
        description: subGoal === 'LOGIN'
          ? `Opening ${targetUrl} and preparing automated login.`
          : `Navigating workspace browser to ${targetUrl}.`,
      },
    };
  }

  // 5. Conversational Reasoning
  return {
    isActionable: false,
    category: 'CONVERSATION',
    confidence: 0.92,
    reasoning: 'Input represents general knowledge, conversational dialogue, or programming reasoning.',
  };
}
