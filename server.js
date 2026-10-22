const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

const {
  initializeApp,
  applicationDefault,
  getApps,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");

dotenv.config();

// Firebase Admin initialization
// Google credentials must be configured securely on the server.
if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const app = express();
app.set("trust proxy", true);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;
const OPENAI_TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `
You are ACD AI v10, an elite strategic decision analyst.

Your job is to compare exactly two options and recommend the stronger one.

IMPORTANT LANGUAGE RULE:
Detect the language used by the user in Option A and Option B.

You MUST answer ALL text fields in the same language as the user.

This includes:
- verdict
- summary
- explanation
- bestFor
- biggestRisk
- nextStep
- decisionStrength
- personalFit
- suggestedDirection
- betterAlternative
- scenario titles
- scenario analysis

Never mix languages.

You must also return:
- language = ISO 639-1 language code when reasonably possible
Examples:
- en
- ro
- es
- fr
- de
- it
- pt

If unsure, return "en".

You analyze based on:
1. Profit potential
2. Risk
3. Scalability
4. Startup cost
5. Time to profit

SCORING RULES:
- All scores must be integers from 0 to 100.
- Do not use a 1-10 scale.
- Do not use decimals.

INTERPRETATION RULES:
- Profit potential: higher = more upside
- Risk: higher = more risky
- Scalability: higher = easier to scale
- Startup cost: higher = more expensive
- Time to profit: higher = slower

CONTEXT AWARENESS RULES:
You must infer useful decision context from the user's wording when possible.

Important signals:
- low budget / cheap / budget small / buget mic / ieftin
- beginner / no experience / începător / incepator / fara experienta / fără experiență
- fast money / quick profit / profit rapid / bani repede
- low risk / safe / risc mic / sigur
- local business / physical business / afacere locală / business local
- online business / digital / global / remote
- Romania / România / local market
- long-term brand / premium brand / brand building
- service business / trade / skill-based work
- scalable business / software / ecommerce / digital products

DECISION INTELLIGENCE:
- If the user emphasizes small budget, penalize options with high startup cost.
- If the user is a beginner, penalize options that require advanced skill, branding, capital, or complex execution.
- If the user wants quick profit, favor options with faster time to profit and simpler validation.
- If the user wants low risk, penalize volatile or branding-heavy options.
- If the user mentions a local market, think realistically about local demand and local execution.
- If one option is service-based and the other is digital, compare realistically:
  - service businesses often validate faster but scale harder
  - digital businesses often scale better but require stronger marketing and patience
- If one option is vague, interpret it reasonably instead of refusing.

DECISION CATEGORY RULES:
You must classify the overall comparison into exactly ONE category:
- Business
- Career
- Money
- Life

Use:
- Business = business ideas, brands, startups, services, ecommerce, apps, agencies
- Career = jobs, freelancing, skills, courses, career paths, employment
- Money = investing, saving, debt, cash flow, financial choices, assets
- Life = relationships, family, health, moving, lifestyle, personal life decisions

Return:
- decisionCategory

The category value itself must stay exactly in English as one of:
- Business
- Career
- Money
- Life

SUGGESTION RULES:
You must also suggest what fits the user best.
Return:
- personalFit = what type of user the winning option fits best
- suggestedDirection = the most realistic direction for this user right now
- betterAlternative = a smarter alternative only if both current options seem weak, too risky, too expensive, or poorly matched; otherwise keep it close to the winner and practical

SCENARIO SIMULATION RULES:
Return exactly 3 scenario simulations.
Each scenario must be practical, short, and useful.
Each scenario must explain how the decision changes under different conditions.

The 3 scenarios should generally cover:
1. Limited capital
2. Need for faster income
3. Long-term scale priority

TRENDING DECISIONS RULES:
Return 3 to 5 AI-generated trending decisions for the same language and same kind of audience.
They must be realistic, clickable, short, and relevant to users of this app.
Each trending decision must contain:
- optionA
- optionB

DECISION RULES:
- Always choose ONE option.
- Never sit on the fence.
- Never say both are equal.
- Be decisive and practical.
- Avoid generic motivational language.
- Sound like a sharp analyst, not a chatbot.
- Keep explanation concise but meaningful.
- Prefer realistic business logic over hype.

CONFIDENCE RULES:
- HIGH = strong practical winner with clear advantage
- MEDIUM = winner exists, but trade-offs are meaningful
- LOW = both are uncertain, vague, or closely matched

Return ONLY valid JSON.

Required JSON structure:
{
  "language": "en",
  "decisionCategory": "Business",
  "verdict": "Recommended: Option A - Label",
  "winner": "A",
  "confidence": "HIGH",
  "summary": "Short summary",
  "explanation": "2-4 sentence reasoning",
  "bestFor": "Who this is best for",
  "biggestRisk": "Main risk",
  "nextStep": "First step",
  "personalFit": "What kind of person this suits best",
  "suggestedDirection": "Best direction for the user right now",
  "betterAlternative": "A smarter alternative if needed",
  "scores": {
    "optionA": {
      "profitPotential": 0,
      "risk": 0,
      "scalability": 0,
      "startupCost": 0,
      "timeToProfit": 0
    },
    "optionB": {
      "profitPotential": 0,
      "risk": 0,
      "scalability": 0,
      "startupCost": 0,
      "timeToProfit": 0
    }
  },
  "scenarios": [
    {
      "title": "If capital is limited",
      "analysis": "..."
    },
    {
      "title": "If fast income is needed",
      "analysis": "..."
    },
    {
      "title": "If long-term scalability matters",
      "analysis": "..."
    }
  ],
  "trendingDecisions": [
    {
      "optionA": "Start a clothing brand",
      "optionB": "Open a barbershop"
    },
    {
      "optionA": "Begin dropshipping",
      "optionB": "Start local services"
    },
    {
      "optionA": "Build an AI agency",
      "optionB": "Launch an ecommerce store"
    }
  ]
}
`;

function clampScore(v) {
  let parsed;

  if (typeof v === "number") {
    parsed = v;
  } else {
    parsed = Number.parseFloat(String(v ?? ""));
  }

  if (!Number.isFinite(parsed)) {
    return 50;
  }

  if (parsed >= 0 && parsed <= 10) {
    parsed *= 10;
  }

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

function normalizeWinner(v) {
  const s = safeString(v).toUpperCase();
  if (s === "A" || s === "B") return s;
  return "A";
}

function normalizeConfidence(v) {
  const s = safeString(v).toUpperCase();
  if (s === "HIGH" || s === "MEDIUM" || s === "LOW") return s;
  return "MEDIUM";
}

function normalizeLanguageCode(v) {
  const s = safeString(v).toLowerCase();
  const allowed = new Set(["en", "ro", "es", "fr", "de", "it", "pt"]);
  if (allowed.has(s)) return s;
  return "en";
}

function normalizeDecisionCategory(v) {
  const s = safeString(v);
  const allowed = new Set(["Business", "Career", "Money", "Life"]);
  if (allowed.has(s)) return s;

  const lower = s.toLowerCase();
  if (lower === "business") return "Business";
  if (lower === "career") return "Career";
  if (lower === "money") return "Money";
  if (lower === "life") return "Life";

  return "";
}

function totalScore(scores) {
  const profit = clampScore(scores.profitPotential);
  const risk = clampScore(scores.risk);
  const scale = clampScore(scores.scalability);
  const cost = clampScore(scores.startupCost);
  const time = clampScore(scores.timeToProfit);

  const total =
    profit +
    (100 - risk) +
    scale +
    (100 - cost) +
    (100 - time);

  return Math.round(total / 5);
}

function detectLanguageCode(text) {
  const t = safeString(text).toLowerCase();
  const hasAny = (signals) => signals.some((signal) => t.includes(signal));

  if (
    hasAny([
      "ă", "â", "î", "ș", "ş", "ț", "ţ",
      "românia", "romania", "buget", "începător", "incepator",
      "fără", "fara", "risc", "afacere", "frizerie", "vreau", "cum"
    ])
  ) {
    return "ro";
  }

  if (
    hasAny([
      "¿", "¡", "negocio", "dinero", "rápido", "rapido", "riesgo",
      "escalabilidad", "empezar", "emprender", "coste", "costo", "tiempo"
    ])
  ) {
    return "es";
  }

  if (
    hasAny([
      "entreprise", "risque", "échelle", "echelle", "bénéfice", "benefice",
      "coût", "cout", "temps", "débutant", "debutant", "france"
    ])
  ) {
    return "fr";
  }

  if (
    hasAny([
      "geschäft", "geschaeft", "risiko", "gewinn", "skalierung",
      "kosten", "zeit", "anfänger", "anfaenger", "deutschland"
    ])
  ) {
    return "de";
  }

  if (
    hasAny([
      "impresa", "rischio", "profitto", "scalabilità", "scalabilita",
      "costo", "tempo", "principiante", "italia"
    ])
  ) {
    return "it";
  }

  if (
    hasAny([
      "negócio", "negocio", "risco", "lucro", "escalabilidade",
      "custo", "tempo", "iniciante", "portugal", "brasil"
    ])
  ) {
    return "pt";
  }

  return "en";
}

function detectDecisionCategory(optionA, optionB) {
  const text = `${safeString(optionA)} ${safeString(optionB)}`.toLowerCase();

  const businessWords = [
    "business", "brand", "shopify", "dropshipping", "agency", "saas",
    "startup", "ecommerce", "store", "app", "product", "franchise",
    "barbershop", "restaurant", "pod", "streetwear", "afacere",
    "magazin", "frizerie", "aplicatie", "aplicație", "servicii",
    "services", "online store", "magazin online"
  ];

  const careerWords = [
    "job", "career", "freelance", "freelancer", "employment", "work",
    "remote job", "promotion", "skill", "course", "internship", "cv",
    "resume", "carieră", "cariera", "angajare", "curs", "kurs",
    "employment path"
  ];

  const moneyWords = [
    "invest", "investment", "bitcoin", "crypto", "stocks", "stock", "etf",
    "savings", "save money", "loan", "debt", "side hustle", "income",
    "profit", "cashflow", "cash flow", "bani", "investiție", "investitie",
    "economii", "venit", "financiar", "financial"
  ];

  const lifeWords = [
    "move", "relationship", "marriage", "travel", "vacation", "city",
    "country", "health", "gym", "diet", "family", "routine", "habit",
    "sleep", "life", "mutare", "relație", "relatie", "căsătorie",
    "casatorie", "vacanță", "vacanta", "familie", "viață", "viata",
    "personal"
  ];

  const countMatches = (words) =>
    words.reduce((acc, word) => (text.includes(word) ? acc + 1 : acc), 0);

  const scores = {
    Business: countMatches(businessWords),
    Career: countMatches(careerWords),
    Money: countMatches(moneyWords),
    Life: countMatches(lifeWords),
  };

  let bestCategory = "Business";
  let bestScore = -1;

  for (const [key, value] of Object.entries(scores)) {
    if (value > bestScore) {
      bestScore = value;
      bestCategory = key;
    }
  }

  return bestCategory;
}

function decisionStrengthFromAdvantage(adv, language = "en") {
  switch (language) {
    case "ro":
      if (adv >= 16) return "Câștigător clar";
      if (adv >= 8) return "Avantaj solid";
      return "Diferență mică";
    case "es":
      if (adv >= 16) return "Ganador claro";
      if (adv >= 8) return "Ventaja sólida";
      return "Diferencia pequeña";
    case "fr":
      if (adv >= 16) return "Gagnant clair";
      if (adv >= 8) return "Avantage solide";
      return "Écart faible";
    case "de":
      if (adv >= 16) return "Klarer Gewinner";
      if (adv >= 8) return "Solider Vorteil";
      return "Kleiner Abstand";
    case "it":
      if (adv >= 16) return "Vincitore chiaro";
      if (adv >= 8) return "Vantaggio solido";
      return "Differenza ridotta";
    case "pt":
      if (adv >= 16) return "Vencedor claro";
      if (adv >= 8) return "Vantagem sólida";
      return "Diferença pequena";
    default:
      if (adv >= 16) return "Strong winner";
      if (adv >= 8) return "Solid edge";
      return "Close call";
  }
}

function extractJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function scoreText(text, words) {
  return words.reduce(
    (acc, word) => (text.includes(word) ? acc + 1 : acc),
    0
  );
}

function buildFallbackSuggestions(language, winnerLabel, context = {}) {
  const {
    lowBudget = false,
    beginner = false,
    quickProfit = false,
    local = false,
    digital = false,
  } = context;

  switch (language) {
    case "ro":
      return {
        personalFit: beginner
          ? "Se potrivește mai bine unui începător care vrea o cale mai clară și mai realistă."
          : lowBudget
          ? "Se potrivește unei persoane care vrea să pornească mai controlat din punct de vedere financiar."
          : quickProfit
          ? "Se potrivește unei persoane care caută validare și venit mai rapid."
          : `Se potrivește persoanelor care vor o direcție practică și clară spre ${winnerLabel}.`,
        suggestedDirection: local
          ? "Începe cu o variantă locală mai simplă, ușor de testat în piață."
          : digital
          ? "Începe cu o variantă digitală mică, validată rapid, înainte de a scala."
          : "Mergi pe varianta cu execuție mai simplă și validare mai rapidă.",
        betterAlternative:
          lowBudget && local
            ? "O variantă și mai bună poate fi un serviciu mobil sau la domiciliu înainte de un spațiu complet."
            : lowBudget && digital
            ? "O alternativă mai bună poate fi un micro-brand sau un produs digital simplu înainte de un business mai mare."
            : beginner
            ? "O alternativă mai bună poate fi să începi cu un test mic, nu direct cu varianta completă."
            : `O alternativă apropiată și mai sigură poate fi o versiune mai mică și mai validabilă a opțiunii ${winnerLabel}.`,
      };

    default:
      return {
        personalFit: beginner
          ? "This fits a beginner better because it offers a clearer and more realistic starting path."
          : lowBudget
          ? "This fits someone who wants a more financially controlled starting point."
          : quickProfit
          ? "This fits someone who wants faster validation and earlier income."
          : `This fits people who want a practical and clearer path toward ${winnerLabel}.`,
        suggestedDirection: local
          ? "Start with a simpler local version that is easier to test in the market."
          : digital
          ? "Start with a smaller digital version and validate it quickly before scaling."
          : "Choose the path with simpler execution and faster validation.",
        betterAlternative:
          lowBudget && local
            ? "A smarter alternative could be a mobile or home-service version before opening a full location."
            : lowBudget && digital
            ? "A smarter alternative could be a micro-brand or a simple digital product before building a larger business."
            : beginner
            ? "A better alternative could be starting with a small test instead of launching the full version immediately."
            : `A safer alternative could be a smaller and easier-to-validate version of option ${winnerLabel}.`,
      };
  }
}

function buildFallbackScenarios(language, context = {}) {
  const { local = false, digital = false } = context;

  if (language === "ro") {
    return [
      {
        title: "Dacă bugetul este limitat",
        analysis: local
          ? "O variantă mai mică, mobilă sau la domiciliu devine mai realistă decât o locație completă."
          : digital
          ? "O variantă digitală simplă sau un test mic devine mai potrivită decât o lansare mare."
          : "Varianta cu cost inițial mai mic și testare mai rapidă devine mai puternică."
      },
      {
        title: "Dacă este nevoie de venit mai rapid",
        analysis:
          "Opțiunea care poate genera bani mai repede și se validează mai ușor în piață devine mai avantajoasă."
      },
      {
        title: "Dacă prioritatea este scalarea pe termen lung",
        analysis:
          "Opțiunea cu scalabilitate mai mare și potențial mai bun de extindere devine alegerea mai puternică."
      },
    ];
  }

  return [
    {
      title: "If capital is limited",
      analysis: local
        ? "A smaller mobile or home-service version becomes more realistic than opening a full location."
        : digital
        ? "A simple digital version or small test becomes smarter than a large launch."
        : "The option with lower startup cost and faster validation becomes stronger."
    },
    {
      title: "If fast income is needed",
      analysis:
        "The option that can generate revenue faster and validate more easily in the market becomes more attractive."
    },
    {
      title: "If long-term scalability matters",
      analysis:
        "The option with higher scalability and stronger expansion potential becomes the better long-term choice."
    },
  ];
}

function normalizeScenarios(rawScenarios, language) {
  const fallbackScenarios = buildFallbackScenarios(language, {});
  const safeArray = Array.isArray(rawScenarios) ? rawScenarios : [];

  const normalized = safeArray
    .slice(0, 3)
    .map((item) => ({
      title: safeString(item?.title),
      analysis: safeString(item?.analysis),
    }))
    .filter((item) => item.title || item.analysis);

  while (normalized.length < 3) {
    normalized.push(fallbackScenarios[normalized.length]);
  }

  return normalized.slice(0, 3);
}

function buildFallbackTrendingDecisions(language) {
  if (language === "ro") {
    return [
      {
        optionA: "Să încep un brand de haine",
        optionB: "Să deschid o frizerie",
      },
      {
        optionA: "Să fac dropshipping",
        optionB: "Să pornesc servicii locale",
      },
      {
        optionA: "Să construiesc o agenție AI",
        optionB: "Să lansez un magazin online",
      },
    ];
  }

  return [
    {
      optionA: "Start a clothing brand",
      optionB: "Open a barbershop",
    },
    {
      optionA: "Begin dropshipping",
      optionB: "Start local services",
    },
    {
      optionA: "Build an AI agency",
      optionB: "Launch an ecommerce store",
    },
  ];
}

function normalizeTrendingDecisions(rawTrending, language) {
  const fallback = buildFallbackTrendingDecisions(language);
  const safeArray = Array.isArray(rawTrending) ? rawTrending : [];

  const normalized = safeArray
    .slice(0, 5)
    .map((item) => ({
      optionA: safeString(item?.optionA),
      optionB: safeString(item?.optionB),
    }))
    .filter((item) => item.optionA && item.optionB);

  while (normalized.length < 3) {
    normalized.push(fallback[normalized.length]);
  }

  return normalized.slice(0, 5);
}

function fallbackAnalysis(optionA, optionB) {
  const combined = `${optionA} ${optionB}`;
  const language = detectLanguageCode(combined);

  const a = safeString(optionA).toLowerCase();
  const b = safeString(optionB).toLowerCase();
  const allText = `${a} ${b}`;

  const digitalWords = [
    "app", "saas", "software", "ai", "brand", "ecommerce", "shopify",
    "digital", "course", "content", "agency", "online", "magazin online",
    "brand online", "aplicatie", "digital products", "digital product",
    "remote", "global",
  ];

  const localWords = [
    "barber", "frizer", "frizerie", "salon", "coffee", "restaurant",
    "construction", "constructii", "service", "repair", "shop", "store",
    "mecanic", "bucatar", "service auto", "local", "physical business",
    "afacere locală", "afacere locala",
  ];

  const beginnerWords = [
    "beginner", "începător", "incepator", "fără experiență",
    "fara experienta", "no experience", "newbie",
  ];

  const lowBudgetWords = [
    "low budget", "small budget", "cheap", "buget mic", "ieftin",
    "little money",
  ];

  const quickProfitWords = [
    "quick profit", "fast money", "profit rapid", "bani repede",
    "quick money", "rapid",
  ];

  const lowRiskWords = [
    "low risk", "safe", "risc mic", "sigur",
  ];

  const aDigital = scoreText(a, digitalWords);
  const bDigital = scoreText(b, digitalWords);
  const aLocal = scoreText(a, localWords);
  const bLocal = scoreText(b, localWords);

  const aBeginner = scoreText(a, beginnerWords);
  const bBeginner = scoreText(b, beginnerWords);

  const aLowBudget = scoreText(a, lowBudgetWords);
  const bLowBudget = scoreText(b, lowBudgetWords);

  const aQuickProfit = scoreText(a, quickProfitWords);
  const bQuickProfit = scoreText(b, quickProfitWords);

  const aLowRisk = scoreText(a, lowRiskWords);
  const bLowRisk = scoreText(b, lowRiskWords);

  let optionAScores = {
    profitPotential: aDigital > aLocal ? 78 : 68,
    risk: aDigital > aLocal ? 66 : 52,
    scalability: aDigital > aLocal ? 84 : 45,
    startupCost: aDigital > aLocal ? 35 : 64,
    timeToProfit: aDigital > aLocal ? 62 : 42,
  };

  let optionBScores = {
    profitPotential: bDigital > bLocal ? 78 : 68,
    risk: bDigital > bLocal ? 66 : 52,
    scalability: bDigital > bLocal ? 84 : 45,
    startupCost: bDigital > bLocal ? 35 : 64,
    timeToProfit: bDigital > bLocal ? 62 : 42,
  };

  if (aLowBudget > 0) optionAScores.startupCost -= 15;
  if (bLowBudget > 0) optionBScores.startupCost -= 15;

  if (aQuickProfit > 0) optionAScores.timeToProfit -= 15;
  if (bQuickProfit > 0) optionBScores.timeToProfit -= 15;

  if (aLowRisk > 0) optionAScores.risk -= 12;
  if (bLowRisk > 0) optionBScores.risk -= 12;

  if (aBeginner > 0 && aDigital > aLocal) {
    optionAScores.risk += 10;
    optionAScores.timeToProfit += 10;
  }

  if (bBeginner > 0 && bDigital > bLocal) {
    optionBScores.risk += 10;
    optionBScores.timeToProfit += 10;
  }

  optionAScores = {
    profitPotential: clampScore(optionAScores.profitPotential),
    risk: clampScore(optionAScores.risk),
    scalability: clampScore(optionAScores.scalability),
    startupCost: clampScore(optionAScores.startupCost),
    timeToProfit: clampScore(optionAScores.timeToProfit),
  };

  optionBScores = {
    profitPotential: clampScore(optionBScores.profitPotential),
    risk: clampScore(optionBScores.risk),
    scalability: clampScore(optionBScores.scalability),
    startupCost: clampScore(optionBScores.startupCost),
    timeToProfit: clampScore(optionBScores.timeToProfit),
  };

  const optionATotal = totalScore(optionAScores);
  const optionBTotal = totalScore(optionBScores);
  const advantage = Math.abs(optionATotal - optionBTotal);
  const decisionStrength = decisionStrengthFromAdvantage(advantage, language);

  const winner = optionATotal >= optionBTotal ? "A" : "B";
  const label = winner === "A" ? optionA : optionB;
  const winnerScores = winner === "A" ? optionAScores : optionBScores;

  const context = {
    lowBudget: scoreText(allText, lowBudgetWords) > 0,
    beginner: scoreText(allText, beginnerWords) > 0,
    quickProfit: scoreText(allText, quickProfitWords) > 0,
    local: scoreText(allText, localWords) > 0,
    digital: scoreText(allText, digitalWords) > 0,
  };

  const suggestions = buildFallbackSuggestions(language, winner, context);
  const scenarios = buildFallbackScenarios(language, context);
  const trendingDecisions = buildFallbackTrendingDecisions(language);
  const decisionCategory = detectDecisionCategory(optionA, optionB);

  if (language === "ro") {
    return {
      language,
      decisionCategory,
      verdict: `Recomandat: Opțiunea ${winner} - ${label}`,
      winner,
      confidence: advantage >= 16 ? "HIGH" : advantage >= 8 ? "MEDIUM" : "LOW",
      summary: `Opțiunea ${winner} pare mai puternică per total.`,
      explanation:
        "Motorul fallback a ales varianta cu echilibrul mai bun între potențial, risc, cost inițial, scalabilitate și timp până la profit.",
      bestFor: "Persoane care caută o oportunitate realistă și mai puternică per total.",
      biggestRisk: "Riscul de execuție și validare în piață.",
      nextStep: "Testează la scară mică înainte să investești mai mult.",
      personalFit: suggestions.personalFit,
      suggestedDirection: suggestions.suggestedDirection,
      betterAlternative: suggestions.betterAlternative,
      scores: {
        optionA: optionAScores,
        optionB: optionBScores,
      },
      winnerScores,
      optionATotal,
      optionBTotal,
      advantage,
      decisionStrength,
      scenarios,
      trendingDecisions,
    };
  }

  return {
    language,
    decisionCategory,
    verdict: `Recommended: Option ${winner} - ${label}`,
    winner,
    confidence: advantage >= 16 ? "HIGH" : advantage >= 8 ? "MEDIUM" : "LOW",
    summary: `Option ${winner} looks stronger overall.`,
    explanation:
      "The fallback engine selected the option with the better balance of upside, risk, startup cost, scalability, and speed to validation.",
    bestFor: "People looking for the strongest realistic opportunity overall.",
    biggestRisk: "Execution and market validation risk.",
    nextStep: "Run a small real-world test before committing more capital.",
    personalFit: suggestions.personalFit,
    suggestedDirection: suggestions.suggestedDirection,
    betterAlternative: suggestions.betterAlternative,
    scores: {
      optionA: optionAScores,
      optionB: optionBScores,
    },
    winnerScores,
    optionATotal,
    optionBTotal,
    advantage,
    decisionStrength,
    scenarios,
    trendingDecisions,
  };
}

function normalizeAnalysis(data, optionA, optionB) {
  const combined = `${optionA} ${optionB}`;
  const fallbackLanguage = detectLanguageCode(combined);
  const language = normalizeLanguageCode(data?.language || fallbackLanguage);

  const winner = normalizeWinner(data?.winner);
  const confidence = normalizeConfidence(data?.confidence);

  const aRaw = data?.scores?.optionA || {};
  const bRaw = data?.scores?.optionB || {};

  const optionAScores = {
    profitPotential: clampScore(aRaw.profitPotential),
    risk: clampScore(aRaw.risk),
    scalability: clampScore(aRaw.scalability),
    startupCost: clampScore(aRaw.startupCost),
    timeToProfit: clampScore(aRaw.timeToProfit),
  };

  const optionBScores = {
    profitPotential: clampScore(bRaw.profitPotential),
    risk: clampScore(bRaw.risk),
    scalability: clampScore(bRaw.scalability),
    startupCost: clampScore(bRaw.startupCost),
    timeToProfit: clampScore(bRaw.timeToProfit),
  };

  const optionATotal = totalScore(optionAScores);
  const optionBTotal = totalScore(optionBScores);
  const advantage = Math.abs(optionATotal - optionBTotal);

  const decisionStrength = safeString(
    data?.decisionStrength,
    decisionStrengthFromAdvantage(advantage, language)
  );

  const winnerScores = winner === "A" ? optionAScores : optionBScores;
  const defaultLabel = winner === "A" ? optionA : optionB;

  const fallbackSuggestions = buildFallbackSuggestions(language, winner, {});
  const scenarios = normalizeScenarios(data?.scenarios, language);
  const trendingDecisions = normalizeTrendingDecisions(
    data?.trendingDecisions,
    language
  );

  const decisionCategory =
    normalizeDecisionCategory(data?.decisionCategory) ||
    detectDecisionCategory(optionA, optionB);

  return {
    language,
    decisionCategory,
    verdict: safeString(
      data?.verdict,
      language === "ro"
        ? `Recomandat: Opțiunea ${winner} - ${defaultLabel}`
        : `Recommended: Option ${winner} - ${defaultLabel}`
    ),
    winner,
    confidence,
    summary: safeString(
      data?.summary,
      language === "ro"
        ? `Opțiunea ${winner} pare mai puternică per total.`
        : `Option ${winner} looks stronger overall.`
    ),
    explanation: safeString(
      data?.explanation,
      language === "ro"
        ? "Această opțiune oferă un echilibru mai bun între potențial, risc, cost și execuție."
        : "This option offers the stronger balance of upside, risk, cost, and execution."
    ),
    bestFor: safeString(
      data?.bestFor,
      language === "ro"
        ? "Persoane care caută oportunitatea cea mai puternică per total."
        : "People seeking the strongest overall opportunity."
    ),
    biggestRisk: safeString(
      data?.biggestRisk,
      language === "ro"
        ? "Riscul de execuție și validare în piață."
        : "Execution and market validation risk."
    ),
    nextStep: safeString(
      data?.nextStep,
      language === "ro"
        ? "Fă un test mic în piață înainte să investești mai mult."
        : "Run a small real-world test."
    ),
    personalFit: safeString(data?.personalFit, fallbackSuggestions.personalFit),
    suggestedDirection: safeString(
      data?.suggestedDirection,
      fallbackSuggestions.suggestedDirection
    ),
    betterAlternative: safeString(
      data?.betterAlternative,
      fallbackSuggestions.betterAlternative
    ),
    scores: {
      optionA: optionAScores,
      optionB: optionBScores,
    },
    winnerScores,
    optionATotal,
    optionBTotal,
    advantage,
    decisionStrength,
    scenarios,
    trendingDecisions,
  };
}

function requestMeta(req) {
  return {
    ip: req.ip,
    method: req.method,
    path: req.path,
    at: new Date().toISOString(),
    userAgent: req.get("user-agent") || "",
  };
}

async function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`OpenAI timeout after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    engine: "ACD AI v10",
    status: "running",
    uptimeSeconds: Math.round(process.uptime()),
    now: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    status: "healthy",
    engine: "ACD AI v10",
    uptimeSeconds: Math.round(process.uptime()),
    now: new Date().toISOString(),
  });
});

app.post("/analyze", async (req, res) => {
  const startedAt = Date.now();
  const meta = requestMeta(req);

  try {
    const optionA = safeString(req.body?.optionA);
    const optionB = safeString(req.body?.optionB);

    console.log("Analyze request received:", {
      ...meta,
      optionALength: optionA.length,
      optionBLength: optionB.length,
    });

    if (!optionA || !optionB) {
      return res.status(400).json({
        error: "Both options required",
      });
    }

    const userPrompt = `
Compare these two options and recommend the stronger one.

Option A: ${optionA}
Option B: ${optionB}

Infer useful context from the wording:
- budget
- experience level
- desired speed to profit
- risk tolerance
- local vs online
- local market mentions

Also classify the comparison into exactly one category:
- Business
- Career
- Money
- Life

Also suggest:
- what fits the user personally
- the most realistic direction right now
- a better alternative if both options are weak or poorly matched

Also return 3 scenario simulations:
1. If capital is limited
2. If fast income is needed
3. If long-term scalability matters

Also return 3 to 5 AI-generated trending decisions for this language and audience.
Each one must contain:
- optionA
- optionB

Make them realistic, clickable, and relevant to the same kind of users who would use this app.

Respond strictly in the same language used by the user.
Return the language code too.

Return JSON only.
`;

    const response = await withTimeout(
      client.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      OPENAI_TIMEOUT_MS
    );

    console.log("OpenAI response received:", {
      ...meta,
      durationMs: Date.now() - startedAt,
    });

    const text = response?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(text);

    if (!parsed) {
      console.warn("OpenAI returned non-JSON; using fallback:", {
        ...meta,
        durationMs: Date.now() - startedAt,
      });
      return res.json(fallbackAnalysis(optionA, optionB));
    }

    const normalized = normalizeAnalysis(parsed, optionA, optionB);
    return res.json(normalized);
  } catch (err) {
    console.error("ACD AI v10 error:", {
      ...meta,
      durationMs: Date.now() - startedAt,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });

    try {
      const optionA = safeString(req.body?.optionA, "Option A");
      const optionB = safeString(req.body?.optionB, "Option B");
      return res.json(fallbackAnalysis(optionA, optionB));
    } catch (_) {
      return res.status(500).json({
        error: "AI engine error",
      });
    }
  }
});



// ============================================================
// ACD AI — VOICE DECISION COACH
// Firebase Auth + RevenueCat Pro + private developer testing
// ============================================================

const crypto = require("node:crypto");

const voiceSessionAttempts = new Map();

const VOICE_LANGUAGES = new Set([
  "en", "ro", "es", "fr", "de", "it", "pt",
]);

const VOICE_MIN_INTERVAL_MS = 30000;

// Private testing: one session issuance per day.
// This is NOT a duration or billing limit.
const VOICE_TEST_DAILY_LIMIT = 1;

// Existing Pro users retain the previous issuance allowance.
// This is NOT a duration or billing limit.
const VOICE_PRO_DAILY_LIMIT = 10;

function voiceDeveloperAllowed(uid) {
  const configured = process.env.VOICE_TEST_FIREBASE_UID || "";

  // Fail closed: empty configuration grants nobody access.
  if (!configured.trim()) return false;

  const allowed = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return allowed.includes(uid);
}

async function voiceHasPro(uid) {
  const apiKey = process.env.REVENUECAT_SECRET_KEY;
  const projectId = process.env.REVENUECAT_PROJECT_ID;
  const entitlementId =
    process.env.REVENUECAT_PRO_ENTITLEMENT_ID;

  if (!apiKey || !projectId || !entitlementId) {
    throw new Error("RevenueCat configuration missing");
  }

  // RevenueCat App User ID must match Firebase UID.
  const url =
    "https://api.revenuecat.com/v2/projects/" +
    encodeURIComponent(projectId) +
    "/customers/" +
    encodeURIComponent(uid) +
    "/active_entitlements";

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    console.error(
      "Voice RevenueCat verification HTTP:",
      response.status
    );
    throw new Error("RevenueCat verification unavailable");
  }

  const data = await response.json();

  if (!Array.isArray(data?.items)) {
    throw new Error("Invalid RevenueCat response");
  }

  return data.items.some((item) => {
    if (item.entitlement_id !== entitlementId) {
      return false;
    }

    if (item.expires_at == null) {
      return true;
    }

    const expiry =
      typeof item.expires_at === "number"
        ? item.expires_at
        : Date.parse(item.expires_at);

    if (!Number.isFinite(expiry)) return false;

    // Handle milliseconds and seconds if numeric.
    const expiryMs =
      typeof item.expires_at === "number" &&
      expiry < 100000000000
        ? expiry * 1000
        : expiry;

    return expiryMs > Date.now();
  });
}

app.post("/voice/session", async (req, res) => {
  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const firebaseToken = authorization.slice(7).trim();

    if (!firebaseToken) {
      return res.status(401).json({
        error: "Invalid authentication",
      });
    }

    // Firebase validates signature, audience and expiry.
    const decoded = await getAuth().verifyIdToken(firebaseToken);
    const uid = decoded.uid;

    if (!uid) {
      return res.status(401).json({
        error: "Invalid user",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: "Voice service unavailable",
      });
    }

    const isDeveloper = voiceDeveloperAllowed(uid);
    let isPro = false;

    // Developer access is intentionally restricted to
    // explicitly configured Firebase UIDs.
    if (!isDeveloper) {
      try {
        isPro = await voiceHasPro(uid);
      } catch (error) {
        console.error(
          "Voice subscription check:",
          error.message
        );

        return res.status(503).json({
          error: "Subscription verification unavailable",
        });
      }

      if (!isPro) {
        return res.status(403).json({
          error: "ACD AI Pro subscription required",
        });
      }
    }

    const plan = isDeveloper ? "developer" : "pro";

    const dailyLimit = isDeveloper
      ? VOICE_TEST_DAILY_LIMIT
      : VOICE_PRO_DAILY_LIMIT;

    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);

    const previous = voiceSessionAttempts.get(uid);

    const record =
      previous?.day === day
        ? previous
        : { day, count: 0, lastAt: 0 };

    if (record.count >= dailyLimit) {
      return res.status(429).json({
        error: "Daily voice session limit reached",
      });
    }

    if (now - record.lastAt < VOICE_MIN_INTERVAL_MS) {
      return res.status(429).json({
        error: "Please wait before starting another session",
      });
    }

    const requestedLanguage =
      typeof req.body?.language === "string"
        ? req.body.language.toLowerCase()
        : "en";

    const language = VOICE_LANGUAGES.has(requestedLanguage)
      ? requestedLanguage
      : "en";

    // Reserve before issuing an ephemeral credential.
    // In-memory accounting is only suitable for testing.
    record.count += 1;
    record.lastAt = now;
    voiceSessionAttempts.set(uid, record);

    const safetyId = crypto
      .createHash("sha256")
      .update(uid)
      .digest("hex");

    const instructions = [
      "You are ACD AI Decision Coach.",
      "You are a specialist in helping people make decisions.",
      "Do not behave like a generic chatbot.",
      "Start by asking what decision the user is facing.",
      "Ask focused questions, one at a time.",
      "Identify Option A and Option B.",
      "Clarify goals, budget, risks, priorities and constraints.",
      "Help the user understand trade-offs.",
      "Do not invent facts or claim guaranteed outcomes.",
      "If important information is missing, explain uncertainty.",
      "After enough information is available, summarize:",
      "Option A, Option B, key advantages, risks,",
      "a tentative recommendation and a practical next step.",
      "Do not claim a formal ACD AI report was saved or generated",
      "unless the application explicitly confirms it.",
      "For medical, legal or financial decisions,",
      "avoid presenting advice as professional certainty.",
      "Speak naturally and keep responses concise.",
      `Respond in language code ${language}.`,
    ].join(" ");

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": safetyId,
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: "gpt-realtime-2.1",
            instructions,
            audio: {
              output: {
                voice: "marin",
              },
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) {
      console.error(
        "OpenAI Realtime HTTP:",
        response.status
      );

      return res.status(502).json({
        error: "Unable to start voice session",
      });
    }

    const session = await response.json();

    if (!session.value) {
      return res.status(502).json({
        error: "Invalid voice session response",
      });
    }

    console.log("Voice session issued:", {
      plan,
      language,
      at: new Date().toISOString(),
    });

    return res.status(200).json({
      client_secret: session.value,
      expires_at: session.expires_at,
      model: "gpt-realtime-2.1",
      language,
      plan,
    });
  } catch (error) {
    if (error?.code?.startsWith?.("auth/")) {
      return res.status(401).json({
        error: "Authentication failed",
      });
    }

    console.error(
      "Voice session error:",
      error?.message || String(error)
    );

    return res.status(500).json({
      error: "Voice session could not be created",
    });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`ACD AI v10 server running on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});