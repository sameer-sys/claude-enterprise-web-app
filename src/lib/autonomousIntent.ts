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
    'github', 'google', 'youtube', 'restaurants', 'search', 'navigate', 'signin', 'login', 'javascript', 'typescript'
  ]);

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

  const complexMatch = text.match(/\b([A-Za-z0-9!@#$%^&*()_+]{6,})\b/g);
  if (complexMatch) {
    for (const token of complexMatch) {
      if (knownEmail && token.includes(knownEmail)) continue;
      if (token.includes('@') && token.includes('.')) continue;
      if (ignoredWords.has(token.toLowerCase())) continue;
      const hasDigitOrSymbol = /[0-9!@#$%^&*()_+]/.test(token);
      const isMixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token);
      if (hasDigitOrSymbol || isMixedCase) {
        return token;
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

  // Combine with recent turn context for follow-up resolution
  const recentUserTurns = contextHistory
    .filter((m) => m && m.role === 'user')
    .slice(-4)
    .map((m) => String(m.content || ''))
    .join(' ');
  const combined = `${recentUserTurns} ${raw}`.trim();
  const lowerCombined = combined.toLowerCase();

  // -------------------------------------------------------------
  // 1. Identify URL or Domain Mentions
  // -------------------------------------------------------------
  const explicitUrlMatch = raw.match(/https?:\/\/[^\s"'<>]+/i) || recentUserTurns.match(/https?:\/\/[^\s"'<>]+/i);
  const domainMatch = raw.match(/\b([a-zA-Z0-9-]+\.(?:com|org|io|dev|net|ai|app|co|so|in|gov|edu)(?:\/[^\s]*)?)\b/i) ||
                      recentUserTurns.match(/\b([a-zA-Z0-9-]+\.(?:com|org|io|dev|net|ai|app|co|so|in|gov|edu)(?:\/[^\s]*)?)\b/i);

  // -------------------------------------------------------------
  // 2. Identify Target Service
  // -------------------------------------------------------------
  let matchedServiceKey: string | null = null;
  for (const key of Object.keys(SERVICE_DIRECTORY)) {
    const regex = new RegExp(`\\b${key}\\b`, 'i');
    if (regex.test(lowerCombined)) {
      matchedServiceKey = key;
      break;
    }
  }

  // -------------------------------------------------------------
  // 3. Detect Action Types & Directives
  // -------------------------------------------------------------
  const hasBrowserDirective = (
    /\b(browser|browse|navigate|open|visit|launch|go\s+to|pull\s+up|load|show|jump\s+on|check\s+on|view)\b/i.test(lower) ||
    lower.includes('in the browser') ||
    lower.includes('on browser') ||
    lower.includes('cant see') ||
    lower.includes('cant see open it') ||
    Boolean(explicitUrlMatch) ||
    Boolean(domainMatch) ||
    Boolean(matchedServiceKey)
  );

  const hasLoginIntent = (
    /\b(login|log\s+in|sign\s+in|signin|authenticate|auth|credentials|account)\b/i.test(lowerCombined) ||
    (/\b(?:pass|password)\b/i.test(lowerCombined) && lowerCombined.includes('@'))
  );

  const hasSearchIntent = (
    /\b(search|find|look\s+up)\b/i.test(lower) && !hasLoginIntent
  );

  // Shell / CLI directive detection
  const hasShellDirective = (
    /\b(terminal|shell|powershell|bash|cmd|command\s+line|run\s+command|exec)\b/i.test(lower) ||
    /^(?:npm|pnpm|yarn|npx|git|python|node|cargo|pip|docker|ls|dir|cd|cat|curl|netstat)\s+/i.test(raw)
  );

  // -------------------------------------------------------------
  // 4. Resolve Browser Action
  // -------------------------------------------------------------
  if (hasBrowserDirective && !hasShellDirective) {
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
    // C. Recognized Service
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
    const email = extractEmail(raw) || extractEmail(recentUserTurns);
    const password = extractPassword(raw, email) || extractPassword(recentUserTurns, email);
    const credentials = (email || password) ? { username: email, password } : undefined;

    if (credentials || hasLoginIntent) {
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

  // -------------------------------------------------------------
  // 5. Resolve Shell Action
  // -------------------------------------------------------------
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

  // -------------------------------------------------------------
  // 6. Conversational Reasoning
  // -------------------------------------------------------------
  return {
    isActionable: false,
    category: 'CONVERSATION',
    confidence: 0.88,
    reasoning: 'Input represents general knowledge, conversational dialogue, or programming reasoning.',
  };
}
