// Mochabot: watches a BlueSky account and cross-posts new content to a Discord channel,
// runs a keyword-based role-ping chat monitor, and manages reaction-role assignment
// (including reconciling roles against reactions added/removed while offline).

import {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    REST,
    Routes,
} from "discord.js";
import { AtpAgent } from "@atproto/api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config"; // Loads variables from .env into process.env

// Load Spanish quiz questions
let spanishQuestions = [];
try {
    const spanishPath = path.join(__dirname, "spanish.json");
    spanishQuestions = JSON.parse(fs.readFileSync(spanishPath, "utf8"));
    console.log(`Loaded ${spanishQuestions.length} Spanish verb questions`);
} catch (error) {
    console.error("Failed to load Spanish quiz questions:", error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CONFIGURATION ====================

// Discord credentials/targets
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DESTINATION_CHANNEL_ID = process.env.DESTINATION_CHANNEL_ID; // Where BlueSky cross-posts are sent
const CHEAPASSGAMER_THREAD_ID = process.env.CHEAPASSGAMER_THREAD_ID; // Thread for cheapassgamer.com posts

// BlueSky login used to read the feed (needs an app password, not the main account password)
const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD;

// BlueSky accounts whose posts get mirrored to Discord
const TARGET_BLUESKY_USERS = [
    process.env.TARGET_BLUESKY_USER,
    "cheapassgamer.com",
];

// How often to poll BlueSky for new posts, in milliseconds
const POLL_INTERVAL_MS = 60000;

// Track the last processed URI for each BlueSky user
const lastProcessedUriMap = {};

// Flavor text shown before the role pings on a cross-posted BlueSky message; one is picked at random
const ROLE_PING_MESSAGES = [
    "TO ME, MY NIGGAS!",
    "which one of you home of sexuals asked for this?",
    "peep this shit cuz.",
    "you got like twenty seconds bro gl",
    "meow meow meow meow meow meow meow bitch meow",
    "quieres?",
    "who wallet got pocket lint and a dream in it cuz...",
    "uwu nyaaaa owo you broke bitch",
    "donate 3 dollars to [synnie's ko-fi](https://ko-fi.com/synnie) to keep me alive i'm so hungry",
    "neko neko beeeeeeeeam",
    "do u mind i am grooming",
    "FOCUS, M!!!",
    "You were excited for this deal until you noticed you only have one rupee in your pocket..."
];

// Only this user may run /say
const SAY_COMMAND_USER_ID = "116938174823006209";

// Developer reminder settings: ping the developer every 28 days
const DEVELOPER_USER_ID = process.env.DEVELOPER_USER_ID || SAY_COMMAND_USER_ID;
const DEVELOPER_REMINDER_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

// Chat keyword monitor settings
const ALLOWED_CHANNELS = ["121721532551528448", "1548135439829835906"];

// Cursed general channel for secret messages
const CURSED_GENERAL_CHANNEL_ID = process.env.CURSED_GENERAL_CHANNEL_ID;

// Haunting messages to send secretly to users
const HAUNTING_MESSAGES = [
    "they know what you did.",
    "the walls are watching.",
    "your secrets are safe... for now.",
    "we remember.",
    "you can't escape what you've become.",
    "the shadows whisper your name.",
    "time moves differently here.",
    "you were never alone.",
    "they're coming for you.",
    "the void calls.",
    "your reflection doesn't match anymore.",
    "sleep is not an escape.",
];

// Auto-haunting settings: randomly haunt users at random times
const AUTO_HAUNT_ENABLED = process.env.AUTO_HAUNT_ENABLED === "true";
const AUTO_HAUNT_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours minimum
const AUTO_HAUNT_MAX_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours maximum
const AUTO_HAUNT_ROLE_ID = "441290984542699521"; // Regulars role

// Role settings: all reaction roles (emoji, role ID, embed label, keywords) live in
// custom-reaction-roles.json instead of here, to keep this file compact. Edit that file
// directly, or use /add-reaction-role, to add/remove entries. KEYWORD_ROLES, EMOJI_ROLE_MAP,
// the setup-roles embed, and its reactions are all generated from the loaded list.
const REACTION_ROLES_PATH = path.join(__dirname, "custom-reaction-roles.json");

function loadReactionRoles() {
    try {
        if (fs.existsSync(REACTION_ROLES_PATH)) {
            return JSON.parse(fs.readFileSync(REACTION_ROLES_PATH, "utf8"));
        }
    } catch (error) {
        console.error("Could not read custom-reaction-roles.json:", error);
    }
    return [];
}

let REACTION_ROLES = loadReactionRoles();

// Derived lookups; recomputed by rebuildRoleLookups() whenever REACTION_ROLES changes
let EMOJI_ROLE_MAP = {};
let KEYWORD_ROLES = {};
let ROLE_KEYWORDS = {};

function rebuildRoleLookups() {
    // emoji ID -> role ID, used by the reaction add/remove handlers and the offline sync
    EMOJI_ROLE_MAP = Object.fromEntries(
        REACTION_ROLES.map(({ emojiId, roleId }) => [emojiId, roleId]),
    );

    // keyword -> role ID, used by the chat keyword monitor and BlueSky cross-post pings
    KEYWORD_ROLES = Object.fromEntries(
        REACTION_ROLES.flatMap(({ keywords, roleId }) =>
            keywords.map((keyword) => [keyword, roleId]),
        ),
    );

    // role ID -> keywords, used purely for logging so logs show what role changed
    ROLE_KEYWORDS = Object.fromEntries(
        REACTION_ROLES.map(({ keywords, roleId }) => [roleId, keywords.join("/")]),
    );
}
rebuildRoleLookups();

// Math quiz settings: periodically challenges a user with a simple algebra equation
const MATH_QUIZ_CHANNEL_ID = process.env.MATH_QUIZ_CHANNEL_ID;
const MATH_QUIZ_USER_ID = process.env.MATH_QUIZ_USER_ID;
const MATH_QUIZ_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Guild the slash commands (/setup-roles, /toonie-math-time) are scoped to, instead of registering them globally
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID;

// Persists the ID of the posted reaction-role menu message across restarts
const CONFIG_PATH = path.join(__dirname, "config.json");

// Track when the last developer reminder was sent
let lastDeveloperReminderTime = 0;

function loadLastReminderTime() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
            return config.lastDeveloperReminderTime || 0;
        }
    } catch (error) {
        console.error("Could not read config.json for reminder time:", error);
    }
    return 0;
}

function saveLastReminderTime() {
    try {
        let config = {};
        if (fs.existsSync(CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        }
        config.lastDeveloperReminderTime = Date.now();
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error("Could not save reminder time to config.json:", error);
    }
}

lastDeveloperReminderTime = loadLastReminderTime();
// =======================================================

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const atpAgent = new AtpAgent({
    service: "https://bsky.social",
});

// Posted math challenges awaiting a reply: message ID -> { answer, userId }
const activeMathChallenges = new Map();

// Storage for math problem history: tracks all problems posted during this session
// Format: { timestamp, messageId, problem, answer, prompt }
const mathProblemHistory = [];

// Map of message IDs to their problem records for quick lookup
const problemsByMessageId = new Map();

// Posted Spanish quiz challenges awaiting a reply: message ID -> { answer, userId }
const activeSpanishChallenges = new Map();

// Storage for Spanish quiz history: tracks all questions posted during this session
// Format: { timestamp, messageId, question, answer, options, prompt }
const spanishQuizHistory = [];

// Map of message IDs to their Spanish question records for quick lookup
const spanishQuestionsByMessageId = new Map();

// Scoped to COMMAND_GUILD_ID (guild commands update instantly, unlike global ones)
const guildSlashCommands = [
    new SlashCommandBuilder()
        .setName("setup-roles")
        .setDescription(
            "Posts the custom reaction role embed in the current channel.",
        ),
    new SlashCommandBuilder()
        .setName("toonie-math-time")
        .setDescription("Posts a random algebra equation for Toonie to solve."),
    new SlashCommandBuilder()
        .setName("math-time-open")
        .setDescription(
            "Posts a random algebra equation open for anyone to solve.",
        ),
    new SlashCommandBuilder()
        .setName("say")
        .setDescription(
            "Makes the bot post a message (Synnie only, screw you guys).",
        )
        .addStringOption((option) =>
            option
                .setName("message")
                .setDescription("The message for the bot to post")
                .setRequired(true),
        )
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("Channel to post in (defaults to the current channel)")
                .setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName("add-reaction-role")
        .setDescription(
            "Adds a new reaction role to the menu (Administrator only).",
        )
        .addStringOption((option) =>
            option
                .setName("emoji")
                .setDescription(
                    "The custom server emoji: paste its raw mention (\\:name:) or just its numeric ID",
                )
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("label")
                .setDescription("Display name shown in the role menu embed")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("keywords")
                .setDescription(
                    "Comma-separated keywords that also ping this role in chat/BlueSky posts",
                )
                .setRequired(true),
        )
        .addRoleOption((option) =>
            option
                .setName("role")
                .setDescription(
                    "The role to grant (leave blank to create a new role automatically)",
                )
                .setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName("haunt")
        .setDescription(
            "Send a haunting secret message to a user in cursed general (Synnie only).",
        )
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("The user to haunt")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("message")
                .setDescription("Custom haunting message (optional, random if not provided)")
                .setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName("math-history")
        .setDescription("View all math problems posted during this session."),
    new SlashCommandBuilder()
        .setName("spanish-quiz")
        .setDescription("Posts a random Spanish verb conjugation question."),
    new SlashCommandBuilder()
        .setName("spanish-history")
        .setDescription("View all Spanish quiz questions posted during this session."),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

discordClient.once("clientReady", async () => {
    console.log(`Logged in as ${discordClient.user.tag}`);

    try {
        // Clears any stale global commands from before commands were switched to guild-scoped
        await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
        await rest.put(
            Routes.applicationGuildCommands(DISCORD_CLIENT_ID, COMMAND_GUILD_ID),
            { body: guildSlashCommands },
        );
        console.log("Slash commands registered.");
    } catch (error) {
        console.error("Error registering slash commands:", error);
    }

    try {
        await atpAgent.login({
            identifier: BLUESKY_HANDLE,
            password: BLUESKY_APP_PASSWORD,
        });
        console.log("Successfully logged into BlueSky!");
        console.log(`Watching BlueSky users: ${TARGET_BLUESKY_USERS.join(", ")}`);
        setInterval(checkBlueSkyPosts, POLL_INTERVAL_MS);
        await checkBlueSkyPosts(); // Run once immediately instead of waiting for the first interval
    } catch (error) {
        console.error("Failed to login to BlueSky:", error);
    }

    setInterval(postScheduledMathChallenge, MATH_QUIZ_INTERVAL_MS);

    // Check for 28-day developer reminder every hour
    setInterval(sendDeveloperReminder, 60 * 60 * 1000);

    // Start auto-haunting if enabled
    if (AUTO_HAUNT_ENABLED) {
        console.log("Auto-haunting enabled. Scheduling first haunt...");
        scheduleAutoHaunt();
    }

    await syncReactionRoles();
});

/**
 * Generates a random math question: polynomial, factoring, series, or functions.
 */
function generateAlgebraEquation() {
    const questionType = randomInt(0, 3);
    switch (questionType) {
        case 0:
            return generateComplexPolynomial();
        case 1:
            return generateFactoringQuadratic();
        case 2:
            return generateNumberSeries();
        case 3:
            return generateFunctionAnalysis();
        default:
            return generateComplexPolynomial();
    }
}

/**
 * Generates a complex polynomial equation of degree 3 or 4 with integer coefficients.
 * Returns an equation in the form ax^n + bx^(n-1) + ... = 0 with at least one integer root.
 */
function generateComplexPolynomial() {
    const degree = randomInt(3, 4); // Degree 3 or 4
    const root1 = randomNonZeroInt(-5, 5);
    const root2 = randomNonZeroInt(-5, 5);
    const root3 = randomNonZeroInt(-5, 5);
    
    let roots = [root1, root2, root3];
    let coefficients;

    if (degree === 4) {
        const root4 = randomNonZeroInt(-5, 5);
        roots.push(root4);
        // Expand (x - root1)(x - root2)(x - root3)(x - root4)
        coefficients = expandPolynomial([
            [1, -root1],
            [1, -root2],
            [1, -root3],
            [1, -root4],
        ]);
    } else {
        // Expand (x - root1)(x - root2)(x - root3)
        coefficients = expandPolynomial([
            [1, -root1],
            [1, -root2],
            [1, -root3],
        ]);
    }

    // Build equation string
    let equationParts = [];
    for (let i = 0; i < coefficients.length; i++) {
        const coeff = coefficients[i];
        const power = coefficients.length - 1 - i;

        if (coeff === 0) continue;

        let term = "";
        if (equationParts.length > 0) {
            term += coeff > 0 ? " + " : " - ";
            term += Math.abs(coeff);
        } else {
            term += coeff;
        }

        if (power > 1) {
            term += `x^${power}`;
        } else if (power === 1) {
            term += "x";
        }

        equationParts.push(term);
    }

    const equation = equationParts.join("") + " = 0";
    const uniqueRoots = [...new Set(roots)].sort((a, b) => a - b);
    const answer = uniqueRoots.map((root) => `x = ${root}`).join(" or ");

    return {
        equation,
        answer,
        prompt: "Find all integer roots:",
    };
}

/**
 * Expands a product of linear polynomials.
 * Each polynomial is represented as [coefficient, constant] for (coeff*x + constant).
 */
function expandPolynomial(polynomials) {
    let result = [1]; // Start with the constant 1

    for (const [coeff, constant] of polynomials) {
        const newResult = new Array(result.length + 1).fill(0);
        for (let i = 0; i < result.length; i++) {
            newResult[i] += result[i] * coeff; // Multiply by coeff*x
            newResult[i + 1] += result[i] * constant; // Multiply by constant
        }
        result = newResult;
    }

    return result;
}

/**
 * Generates a quadratic equation in the form ax^2 + bx + c = 0 that factors nicely.
 * The user must factor it into the form (px + q)(rx + s) = 0.
 */
function generateFactoringQuadratic() {
    // Generate two linear factors: (ax + b)(cx + d)
    const a = randomNonZeroInt(-3, 3);
    const b = randomNonZeroInt(-5, 5);
    const c = randomNonZeroInt(-3, 3);
    const d = randomNonZeroInt(-5, 5);

    // Expand (ax + b)(cx + d) = acx^2 + (ad + bc)x + bd
    const A = a * c;
    const B = a * d + b * c;
    const C = b * d;

    // Format the equation
    let equationParts = [];

    if (A !== 0) {
        equationParts.push(A === 1 ? "x^2" : A === -1 ? "-x^2" : `${A}x^2`);
    }

    if (B !== 0) {
        const sign = B > 0 ? " + " : " - ";
        equationParts.push(sign + (Math.abs(B) === 1 ? "x" : `${Math.abs(B)}x`));
    }

    if (C !== 0) {
        const sign = C > 0 ? " + " : " - ";
        equationParts.push(sign + Math.abs(C));
    }

    const equation = equationParts.join("") + " = 0";

    // Format the factored form for the answer
    const factor1 = a === 1 ? `x + ${b}` : a === -1 ? `-x + ${b}` : `${a}x + ${b}`;
    const factor2 = c === 1 ? `x + ${d}` : c === -1 ? `-x + ${d}` : `${c}x + ${d}`;
    const factored = `(${factor1})(${factor2})`;

    // Calculate the roots for verification
    const root1 = -b / a;
    const root2 = -d / c;

    return {
        equation,
        answer: factored,
        prompt: "Factor the quadratic:",
    };
}

/**
 * Generates a challenging number series problem with various patterns.
 * Patterns include: polynomial sequences, Fibonacci-like, geometric with twist, etc.
 */
function generateNumberSeries() {
    const seriesType = randomInt(0, 4);
    let series, nextNumber, pattern;

    switch (seriesType) {
        case 0:
            // Quadratic sequence: differences of differences are constant
            return generateQuadraticSequence();
        case 1:
            // Cubic sequence: third differences are constant
            return generateCubicSequence();
        case 2:
            // Fibonacci-like with multiplier: a(n) = a(n-1) + 2*a(n-2)
            return generateFibonacciVariant();
        case 3:
            // Geometric sequence with arithmetic twist
            return generateGeometricWithTwist();
        case 4:
            // Prime-based or factorial-based sequence
            return generateAdvancedSequence();
        default:
            return generateQuadraticSequence();
    }
}

/**
 * Generates a quadratic sequence (second differences constant).
 * Example: 2, 5, 10, 17, 26, ? → differences: 3, 5, 7, 9 (constant diff of 2)
 */
function generateQuadraticSequence() {
    const a = randomNonZeroInt(-3, 3); // Coefficient of n^2
    const b = randomNonZeroInt(-5, 5); // Coefficient of n
    const c = randomNonZeroInt(-5, 5); // Constant

    const series = [];
    for (let n = 1; n <= 6; n++) {
        series.push(a * n * n + b * n + c);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates a cubic sequence (third differences constant).
 * Much harder than quadratic.
 */
function generateCubicSequence() {
    const a = randomNonZeroInt(-2, 2); // Coefficient of n^3
    const b = randomNonZeroInt(-3, 3); // Coefficient of n^2
    const c = randomNonZeroInt(-3, 3); // Coefficient of n
    const d = randomNonZeroInt(-5, 5); // Constant

    const series = [];
    for (let n = 1; n <= 6; n++) {
        series.push(a * n * n * n + b * n * n + c * n + d);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates a Fibonacci-like sequence with a twist.
 * a(n) = a(n-1) + k*a(n-2) where k is a random multiplier.
 */
function generateFibonacciVariant() {
    const k = randomNonZeroInt(-3, 3);
    const start1 = randomInt(1, 5);
    const start2 = randomInt(1, 5);

    const series = [start1, start2];
    for (let i = 2; i < 6; i++) {
        series.push(series[i - 1] + k * series[i - 2]);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates a geometric sequence with an arithmetic twist.
 * Example: multiply by r, then add/subtract a constant each step.
 */
function generateGeometricWithTwist() {
    const r = randomNonZeroInt(-3, 3); // Multiplier
    const twist = randomNonZeroInt(-5, 5); // Arithmetic twist
    const start = randomInt(1, 3);

    const series = [start];
    for (let i = 1; i < 6; i++) {
        series.push(series[i - 1] * r + twist);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates an advanced sequence based on primes, factorials, or combined patterns.
 */
function generateAdvancedSequence() {
    const advancedType = randomInt(0, 2);

    if (advancedType === 0) {
        // Factorial-based: n! + n, n! - n, etc.
        const factorials = [1, 2, 6, 24, 120, 720];
        const operation = randomInt(0, 2);
        const series = factorials.map((f, i) => {
            const n = i + 1;
            if (operation === 0) return f + n;
            if (operation === 1) return f - n;
            return f * n;
        });

        const answer = series[5];
        const displaySeries = series.slice(0, 5).join(", ");

        return {
            equation: displaySeries + ", ?",
            answer: String(answer),
            prompt: "Find the next number in the sequence:",
        };
    } else if (advancedType === 1) {
        // Powers with offset: 2^n + n^2, 3^n - n, etc.
        const base = randomInt(2, 4);
        const operation = randomInt(0, 1);
        const series = [];
        for (let n = 1; n <= 6; n++) {
            if (operation === 0) {
                series.push(Math.pow(base, n) + n * n);
            } else {
                series.push(Math.pow(base, n) - n);
            }
        }

        const answer = series[5];
        const displaySeries = series.slice(0, 5).join(", ");

        return {
            equation: displaySeries + ", ?",
            answer: String(answer),
            prompt: "Find the next number in the sequence:",
        };
    } else {
        // Alternating pattern with increasing complexity
        const series = [];
        for (let n = 1; n <= 6; n++) {
            if (n % 2 === 1) {
                series.push(n * n * n); // Odd positions: cubes
            } else {
                series.push(n * (n + 1)); // Even positions: n(n+1)
            }
        }

        const answer = series[5];
        const displaySeries = series.slice(0, 5).join(", ");

        return {
            equation: displaySeries + ", ?",
            answer: String(answer),
            prompt: "Find the next number in the sequence:",
        };
    }
}

/**
 * Generates a function analysis problem.
 * Types: find domain, find range, find critical points, find asymptotes, etc.
 */
function generateFunctionAnalysis() {
    const analysisType = randomInt(0, 4);

    switch (analysisType) {
        case 0:
            return generateDomainProblem();
        case 1:
            return generateRangeProblem();
        case 2:
            return generateCriticalPointsProblem();
        case 3:
            return generateAsymptoteProblem();
        case 4:
            return generateCompositionProblem();
        default:
            return generateDomainProblem();
    }
}

/**
 * Find the domain of a function (where it's defined).
 */
function generateDomainProblem() {
    const domainType = randomInt(0, 3);
    let func, answer, explanation;

    if (domainType === 0) {
        // Rational function: f(x) = 1/(x - a)
        const a = randomNonZeroInt(-5, 5);
        func = `f(x) = 1/(x - ${a})`;
        answer = `x ≠ ${a}` + (a > 0 ? ` or (-∞, ${a}) ∪ (${a}, ∞)` : ` or (-∞, ${a}) ∪ (${a}, ∞)`);
    } else if (domainType === 1) {
        // Square root: f(x) = √(x - a)
        const a = randomNonZeroInt(-5, 5);
        func = `f(x) = √(x - ${a})`;
        answer = `x ≥ ${a}` + (a > 0 ? ` or [${a}, ∞)` : ` or [${a}, ∞)`);
    } else if (domainType === 2) {
        // Rational with quadratic denominator: f(x) = 1/(x² - a)
        const a = randomInt(1, 5);
        const sqrtA = Math.sqrt(a);
        func = `f(x) = 1/(x² - ${a})`;
        answer = `x ≠ ±${sqrtA}` + (Number.isInteger(sqrtA) ? ` or ℝ \\ {-${sqrtA}, ${sqrtA}}` : "");
    } else {
        // Logarithm: f(x) = ln(x - a)
        const a = randomNonZeroInt(-5, 5);
        func = `f(x) = ln(x - ${a})`;
        answer = `x > ${a}` + (a > 0 ? ` or (${a}, ∞)` : ` or (${a}, ∞)`);
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Find the domain:",
    };
}

/**
 * Find the range of a function (all possible output values).
 */
function generateRangeProblem() {
    const rangeType = randomInt(0, 2);
    let func, answer;

    if (rangeType === 0) {
        // Quadratic: f(x) = a(x - h)² + k (vertex form)
        const a = randomNonZeroInt(-3, 3);
        const h = randomNonZeroInt(-3, 3);
        const k = randomNonZeroInt(-5, 5);
        const sign = a > 0 ? "≥" : "≤";
        func = `f(x) = ${a}(x - ${h})² + ${k}`;
        answer = `y ${sign} ${k}` + (a > 0 ? ` or [${k}, ∞)` : ` or (-∞, ${k}]`);
    } else if (rangeType === 1) {
        // Rational: f(x) = (ax + b)/(x + c) has horizontal asymptote
        const a = randomNonZeroInt(-3, 3);
        const b = randomNonZeroInt(-5, 5);
        const c = randomNonZeroInt(-5, 5);
        func = `f(x) = (${a}x + ${b})/(x + ${c})`;
        answer = `y ≠ ${a}` + ` or ℝ \\ {${a}}`;
    } else {
        // Exponential: f(x) = a·b^x + c
        const a = randomInt(1, 3);
        const b = randomInt(2, 4);
        const c = randomNonZeroInt(-3, 3);
        const sign = c > 0 ? ">" : "<";
        func = `f(x) = ${a}·${b}^x + ${c}`;
        answer = `y ${sign} ${c}` + (c > 0 ? ` or (${c}, ∞)` : ` or (-∞, ${c})`);
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Find the range:",
    };
}

/**
 * Find critical points (where derivative = 0 or undefined).
 */
function generateCriticalPointsProblem() {
    const a = randomNonZeroInt(-3, 3);
    const b = randomNonZeroInt(-5, 5);
    const c = randomNonZeroInt(-5, 5);

    // f(x) = ax³ + bx² + cx
    // f'(x) = 3ax² + 2bx + c
    // Critical points where f'(x) = 0

    const discriminant = 4 * b * b - 12 * a * c;
    let answer;

    if (discriminant < 0) {
        answer = "No real critical points";
    } else if (discriminant === 0) {
        const x = (-2 * b) / (6 * a);
        answer = `x = ${x}`;
    } else {
        const sqrtDisc = Math.sqrt(discriminant);
        const x1 = ((-2 * b + sqrtDisc) / (6 * a)).toFixed(2);
        const x2 = ((-2 * b - sqrtDisc) / (6 * a)).toFixed(2);
        answer = `x = ${x1}, x = ${x2}`;
    }

    const func = `f(x) = ${a}x³ + ${b}x² + ${c}x`;

    return {
        equation: func,
        answer: answer,
        prompt: "Find the critical points:",
    };
}

/**
 * Find vertical and horizontal asymptotes.
 */
function generateAsymptoteProblem() {
    const asymptoteType = randomInt(0, 1);
    let func, answer;

    if (asymptoteType === 0) {
        // Vertical asymptotes from denominator zeros
        const a = randomNonZeroInt(-3, 3);
        const b = randomNonZeroInt(-3, 3);
        const c = randomNonZeroInt(-5, 5);
        func = `f(x) = (${a}x + ${b})/((x - ${c})(x + ${c}))`;
        answer = `Vertical: x = ${c}, x = -${c}; Horizontal: y = 0`;
    } else {
        // Horizontal asymptotes from degree comparison
        const a = randomNonZeroInt(-3, 3);
        const b = randomNonZeroInt(-3, 3);
        const c = randomNonZeroInt(1, 3);
        const d = randomNonZeroInt(1, 3);
        func = `f(x) = (${a}x² + ${b}x)/(${c}x² + ${d})`;
        const horizontalAsymptote = (a / c).toFixed(2);
        answer = `Vertical: x = 0; Horizontal: y = ${horizontalAsymptote}`;
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Find the asymptotes:",
    };
}

/**
 * Find the composition of two functions.
 */
function generateCompositionProblem() {
    const a = randomNonZeroInt(-3, 3);
    const b = randomNonZeroInt(-5, 5);
    const c = randomNonZeroInt(-3, 3);
    const d = randomNonZeroInt(-5, 5);

    // f(x) = ax + b
    // g(x) = cx + d
    // Find f(g(x)) or g(f(x))

    const compositionType = randomInt(0, 1);
    let func, answer;

    if (compositionType === 0) {
        // f(g(x))
        const coeff = a * c;
        const constant = a * d + b;
        func = `f(x) = ${a}x + ${b}, g(x) = ${c}x + ${d}. Find f(g(x)):`;
        answer = `f(g(x)) = ${coeff}x + ${constant}`;
    } else {
        // g(f(x))
        const coeff = c * a;
        const constant = c * b + d;
        func = `f(x) = ${a}x + ${b}, g(x) = ${c}x + ${d}. Find g(f(x)):`;
        answer = `g(f(x)) = ${coeff}x + ${constant}`;
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Solve the function composition:",
    };
}

/**
 * Generates a Spanish verb conjugation question from the loaded quiz.
 */
function generateSpanishVerbQuestion() {
    if (spanishQuestions.length === 0) {
        // Fallback if Spanish questions didn't load
        return {
            equation: "Spanish quiz not loaded",
            answer: "Error",
            prompt: "Error:",
        };
    }

    // Pick a random question from the Spanish quiz
    const quizQuestion = spanishQuestions[randomInt(0, spanishQuestions.length - 1)];
    
    // Format the question with options
    const optionsText = quizQuestion.options
        .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
        .join(" | ");
    
    const equation = `${quizQuestion.question}\n${optionsText}`;
    
    // The correct answer is the first option (index 0)
    const correctAnswer = quizQuestion.options[0];

    return {
        equation,
        answer: correctAnswer,
        prompt: "Spanish Verb Conjugation - Choose the correct answer:",
    };
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomNonZeroInt(min, max) {
    let value;
    do {
        value = randomInt(min, max);
    } while (value === 0);
    return value;
}

/**
 * Posts a random algebra equation to the given channel. If targetUserId is set, that user
 * is tagged and is the only one who can reveal the answer by replying; otherwise the
 * challenge is untagged and open for anyone to answer.
 */
async function postMathChallenge(channel, targetUserId = MATH_QUIZ_USER_ID) {
    try {
        if (!channel) {
            console.error("Math quiz channel not found.");
            return;
        }

        const { equation, answer, prompt } = generateAlgebraEquation();
        const mention = targetUserId ? `<@${targetUserId}> ` : "";
        const message = await channel.send(
            `${mention}${prompt}\n\`\`\`\n${equation}\n\`\`\``,
        );
        activeMathChallenges.set(message.id, { answer, userId: targetUserId });
        
        // Store in problem history
        const problemRecord = {
            timestamp: new Date().toISOString(),
            messageId: message.id,
            problem: equation,
            answer: answer,
            prompt: prompt,
        };
        mathProblemHistory.push(problemRecord);
        problemsByMessageId.set(message.id, problemRecord);
        
        console.log(`Math challenge posted (${answer})`);
    } catch (error) {
        console.error("Error posting math challenge:", error);
    }
}

/**
 * Wraps postMathChallenge for the 30-minute timer, which always posts to MATH_QUIZ_CHANNEL_ID
 * regardless of where a slash command might otherwise be run from.
 */
async function postScheduledMathChallenge() {
    const channel = await discordClient.channels
        .fetch(MATH_QUIZ_CHANNEL_ID)
        .catch(() => null);
    await postMathChallenge(channel);
}

/**
 * Posts a random Spanish verb conjugation question to the given channel.
 */
async function postSpanishQuiz(channel) {
    try {
        if (!channel) {
            console.error("Channel not found for Spanish quiz.");
            return;
        }

        if (spanishQuestions.length === 0) {
            await channel.send("Spanish quiz questions not loaded.");
            return;
        }

        const quizQuestion = spanishQuestions[randomInt(0, spanishQuestions.length - 1)];
        const optionsText = quizQuestion.options
            .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
            .join("\n");

        const message = await channel.send(
            `**Spanish Verb Conjugation**\n\n${quizQuestion.question}\n\n${optionsText}`
        );

        activeSpanishChallenges.set(message.id, { answer: quizQuestion.options[0] });

        // Store in quiz history
        const questionRecord = {
            timestamp: new Date().toISOString(),
            messageId: message.id,
            question: quizQuestion.question,
            answer: quizQuestion.options[0],
            options: quizQuestion.options,
            prompt: "Spanish Verb Conjugation",
        };
        spanishQuizHistory.push(questionRecord);
        spanishQuestionsByMessageId.set(message.id, questionRecord);

        console.log(`Spanish quiz question posted (${quizQuestion.options[0]})`);
    } catch (error) {
        console.error("Error posting Spanish quiz:", error);
    }
}

/**
 * Sends a 28-day reminder to the developer via DM, but only if 28 days have passed since the last one.
 */
async function sendDeveloperReminder() {
    const now = Date.now();
    const timeSinceLastReminder = now - lastDeveloperReminderTime;

    // Only send if 28 days have passed
    if (timeSinceLastReminder < DEVELOPER_REMINDER_INTERVAL_MS) {
        return;
    }

    try {
        const user = await discordClient.users.fetch(DEVELOPER_USER_ID);
        await user.send(
            "father, i need l00ps, pls log into the server and verify activity or i WILL shit on your bed"
        );
        lastDeveloperReminderTime = now;
        saveLastReminderTime();
        console.log(`Sent 28-day reminder to developer (${user.tag})`);
    } catch (error) {
        console.error("Failed to send developer reminder:", error);
    }
}

/**
 * Automatically sends a haunting message to a random guild member with the Regulars role at random intervals.
 */
async function scheduleAutoHaunt() {
    if (!AUTO_HAUNT_ENABLED) return;

    try {
        const channel = await discordClient.channels.fetch(
            CURSED_GENERAL_CHANNEL_ID
        );
        if (!channel) {
            console.error("Cursed general channel not found for auto-haunt.");
            return;
        }

        // Get all members from the guild
        const guild = channel.guild;
        const members = await guild.members.fetch();
        
        // Filter for non-bot members who have the Regulars role
        const regularsWithRole = members.filter(
            (m) => !m.user.bot && m.roles.cache.has(AUTO_HAUNT_ROLE_ID)
        );

        if (regularsWithRole.size === 0) {
            console.log("No Regulars to haunt.");
            return;
        }

        // Pick a random member from the Regulars
        const randomMember = regularsWithRole.random();
        const hauntingMessage =
            HAUNTING_MESSAGES[randomInt(0, HAUNTING_MESSAGES.length - 1)];

        // Send as DM so only the target user sees it
        try {
            await randomMember.user.send(hauntingMessage);
        } catch (dmError) {
            // If DM fails, try sending in the channel as a fallback
            console.warn(
                `Could not DM ${randomMember.user.tag}, attempting channel send...`
            );
            await channel.send({
                content: `<@${randomMember.id}> ${hauntingMessage}`,
                flags: MessageFlags.Ephemeral,
            });
        }

        console.log(
            `Auto-haunted Regular ${randomMember.user.tag}: "${hauntingMessage}"`
        );
    } catch (error) {
        console.error("Failed to auto-haunt:", error);
    }

    // Schedule the next haunt at a random time
    const nextHauntDelay = randomInt(
        AUTO_HAUNT_MIN_INTERVAL_MS,
        AUTO_HAUNT_MAX_INTERVAL_MS
    );
    setTimeout(scheduleAutoHaunt, nextHauntDelay);
}

// Reveals the answer only when the tagged user replies directly to their posted challenge
discordClient.on("messageCreate", async (message) => {
    const challengeMessageId = message.reference?.messageId;
    if (!challengeMessageId) return;

    // Check if this is a reply to a math challenge
    const mathChallenge = activeMathChallenges.get(challengeMessageId);
    const mathProblem = problemsByMessageId.get(challengeMessageId);
    
    if (mathChallenge && mathProblem) {
        if (mathChallenge.userId && message.author.id !== mathChallenge.userId) return;

        activeMathChallenges.delete(challengeMessageId);

        let response = `The answer was **${mathChallenge.answer}**!`;
        response += `\n\n**Problem:**\n\`\`\`\n${mathProblem.problem}\n\`\`\``;
        response += `\n**Your answer:** ${message.content}`;
        
        const userAnswer = message.content.trim().toLowerCase();
        const correctAnswer = mathChallenge.answer.toLowerCase();
        
        if (userAnswer === correctAnswer) {
            response += `\n✅ **Correct!**`;
        } else {
            response += `\n❌ **Incorrect.** The correct answer was: ${mathChallenge.answer}`;
        }

        await message.reply(response);
        return;
    }

    // Check if this is a reply to a Spanish quiz question
    const spanishChallenge = activeSpanishChallenges.get(challengeMessageId);
    const spanishQuestion = spanishQuestionsByMessageId.get(challengeMessageId);
    
    if (spanishChallenge && spanishQuestion) {
        activeSpanishChallenges.delete(challengeMessageId);

        let response = `The answer was **${spanishChallenge.answer}**!`;
        response += `\n\n**Question:**\n${spanishQuestion.question}`;
        const optionsText = spanishQuestion.options
            .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
            .join("\n");
        response += `\n${optionsText}`;
        response += `\n**Your answer:** ${message.content}`;
        
        const userAnswer = message.content.trim().toLowerCase();
        const correctAnswer = spanishChallenge.answer.toLowerCase();
        
        if (userAnswer === correctAnswer) {
            response += `\n✅ **Correct!**`;
        } else {
            response += `\n❌ **Incorrect.** The correct answer was: ${spanishChallenge.answer}`;
        }

        await message.reply(response);
        return;
    }
});

/**
 * Polls all target BlueSky accounts for new posts and forwards any that
 * haven't been seen yet to the configured Discord channel.
 */
async function checkBlueSkyPosts() {
    try {
        const channel = await discordClient.channels.fetch(DESTINATION_CHANNEL_ID);
        if (!channel) {
            console.error("Destination channel not found.");
            return;
        }

        // Check each BlueSky user
        for (const user of TARGET_BLUESKY_USERS) {
            try {
                // limit=5 catches quick bursts of posts; "posts_no_replies" skips replies to others
                const response = await atpAgent.getAuthorFeed({
                    actor: user,
                    limit: 5,
                    filter: "posts_no_replies",
                });

                const feed = response.data.feed;
                if (!feed || feed.length === 0) continue;

                // Initialize tracking for this user if first run
                if (!lastProcessedUriMap[user]) {
                    lastProcessedUriMap[user] = feed[0].post.uri;
                    console.log(`Baseline established. Watching ${user}...`);
                    continue;
                }

                // Feed is newest-first; collect everything up to the last post we already handled
                const newPosts = [];
                for (const feedView of feed) {
                    if (feedView.post.uri === lastProcessedUriMap[user]) break;
                    newPosts.push(feedView);
                }

                if (newPosts.length === 0) continue;

                lastProcessedUriMap[user] = feed[0].post.uri;
                newPosts.reverse(); // Send oldest-to-newest so Discord message order matches posting order

                // Route cheapassgamer.com posts to a thread, others to the main channel
                let targetChannel = channel;
                if (user === "cheapassgamer.com" && CHEAPASSGAMER_THREAD_ID) {
                    try {
                        targetChannel = await discordClient.channels.fetch(CHEAPASSGAMER_THREAD_ID);
                    } catch (threadError) {
                        console.error(`Could not fetch cheapassgamer thread (${CHEAPASSGAMER_THREAD_ID}):`, threadError);
                        targetChannel = channel; // Fallback to main channel
                    }
                }

                for (const feedView of newPosts) {
                    await postToDiscord(targetChannel, feedView.post);
                }
            } catch (userError) {
                console.error(`Error checking BlueSky feed for ${user}:`, userError);
            }
        }
    } catch (error) {
        console.error("Error checking BlueSky feeds:", error);
    }
}

/**
 * Builds a Discord embed for a single BlueSky post and sends it to the given channel,
 * pinging any roles whose keyword matches the post text.
 */
async function postToDiscord(channel, post) {
    const author = post.author;
    const record = post.record;
    const postSlug = post.uri.split("/").pop();
    const rawText = record.text || "";
    const profileUrl = `https://bsky.app/profile/${author.handle}`;

    // Ping every role whose keyword appears anywhere in the post text
    const rolesToPing = Object.entries(KEYWORD_ROLES)
        .filter(([keyword]) => rawText.toLowerCase().includes(keyword))
        .map(([, roleId]) => `<@&${roleId}>`);

    // Turns BlueSky's link/mention/tag facets into markdown links so they're clickable in Discord
    const displayText = applyRichTextFacets(rawText, record.facets);

    const embed = new EmbedBuilder()
        .setDescription(displayText)
        .setColor(0x0085ff)
        .setURL(`${profileUrl}/post/${postSlug}`)
        .setAuthor({
            name: `${author.displayName || author.handle} (@${author.handle})`,
            iconURL: author.avatar,
            url: profileUrl,
        })
        .setFooter({
            text: "Posted on BlueSky",
            iconURL: "https://web-cdn.bsky.app/static/favicon.png",
        });

    const imageUrl = extractEmbedImageUrl(post.embed);
    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    const messagePayload = { embeds: [embed] };
    if (rolesToPing.length > 0) {
        // Get the Zelda role ID from REACTION_ROLES if it exists
        const zeldaRole = REACTION_ROLES.find(
            (role) => role.keywords.includes("zelda")
        );
        const isZeldaPing = zeldaRole && rolesToPing.includes(`<@&${zeldaRole.roleId}>`);

        // Filter ping messages: exclude rupee message unless it's a Zelda ping
        const availableMessages = ROLE_PING_MESSAGES.filter((msg) => {
            const isRupeeMessage = msg.includes("rupee");
            return isRupeeMessage ? isZeldaPing : true;
        });

        const pingMessage =
            availableMessages[randomInt(0, availableMessages.length - 1)];
        messagePayload.content = `${pingMessage} ${rolesToPing.join(" ")}`;
    }

    await channel.send(messagePayload);

    // Post video separately so Discord auto-embeds it
    const videoUrl = extractEmbedVideoUrl(post.embed);
    if (videoUrl) {
        console.log(`Posting video: ${videoUrl}`);
        await channel.send(videoUrl);
    } else if (post.embed) {
        console.log(`Post has embed but no video extracted. Embed type: ${post.embed.$type}`);
    }
}

/**
 * Pulls a displayable image URL out of a post's embed view, if it has one.
 * Handles plain image posts, link cards, and quote posts that also attach media
 * (recordWithMedia) — each of these shapes nests the image data differently.
 */
function extractEmbedImageUrl(embed) {
    if (!embed) return null;

    switch (embed.$type) {
        case "app.bsky.embed.images#view":
            return embed.images?.[0]?.fullsize ?? null;
        case "app.bsky.embed.external#view":
            return embed.external?.thumb ?? null;
        case "app.bsky.embed.recordWithMedia#view":
            return extractEmbedImageUrl(embed.media);
        default:
            return null;
    }
}

/**
 * Pulls a displayable video URL out of a post's embed view, if it has one.
 * Handles plain video posts and quote posts that also attach media (recordWithMedia).
 */
function extractEmbedVideoUrl(embed) {
    if (!embed) return null;

    console.log(`Checking embed type: ${embed.$type}`);

    switch (embed.$type) {
        case "app.bsky.embed.video#view":
            const videoUrl = embed.video?.cid ? `https://cdn.bsky.app/video/${embed.video.cid}` : null;
            console.log(`Video embed found. CID: ${embed.video?.cid}, URL: ${videoUrl}`);
            return videoUrl;
        case "app.bsky.embed.recordWithMedia#view":
            console.log(`RecordWithMedia found, recursing...`);
            return extractEmbedVideoUrl(embed.media);
        default:
            return null;
    }
}

/**
 * Converts BlueSky rich-text facets (links, mentions, tags) into markdown links so they
 * render as clickable text in a Discord embed instead of plain, inert text. Facet byte
 * ranges are UTF-8 offsets, so slicing is done on a Buffer rather than the JS string.
 * Any bare URLs left outside of a facet are wrapped in angle brackets so Discord doesn't
 * generate a second, unfurled embed underneath the post.
 */
function applyRichTextFacets(text, facets) {
    if (!facets || facets.length === 0) return suppressBareLinks(text);

    const textBytes = Buffer.from(text, "utf8");
    const sortedFacets = [...facets].sort(
        (a, b) => a.index.byteStart - b.index.byteStart,
    );

    let result = "";
    let cursor = 0;

    for (const facet of sortedFacets) {
        const { byteStart, byteEnd } = facet.index;
        if (byteStart < cursor || byteEnd > textBytes.length) continue; // Skip out-of-order/invalid facets

        result += suppressBareLinks(
            textBytes.subarray(cursor, byteStart).toString("utf8"),
        );
        const segment = textBytes.subarray(byteStart, byteEnd).toString("utf8");
        const feature = facet.features?.[0];

        if (feature?.$type === "app.bsky.richtext.facet#link") {
            result += `[${segment}](${feature.uri})`;
        } else if (feature?.$type === "app.bsky.richtext.facet#mention") {
            result += `[${segment}](https://bsky.app/profile/${feature.did})`;
        } else if (feature?.$type === "app.bsky.richtext.facet#tag") {
            result += `[${segment}](https://bsky.app/hashtag/${feature.tag})`;
        } else {
            result += segment;
        }

        cursor = byteEnd;
    }

    result += suppressBareLinks(textBytes.subarray(cursor).toString("utf8"));
    return result;
}

/**
 * Wraps bare URLs in angle brackets (Discord's "no embed" link syntax) so they render as
 * plain clickable text instead of triggering a second, unfurled embed under the message.
 */
function suppressBareLinks(text) {
    return text.replace(/https?:\/\/[^\s<>]+/g, "<$&>");
}

/**
 * Reads the message ID of the currently-posted reaction-role menu from config.json.
 */
function getActiveMessageId() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
            return parsed.reactionMessageId;
        }
    } catch (error) {
        console.error("Could not read config.json:", error);
    }
    return null;
}

/**
 * On startup, reconciles member roles against the reactions actually present on the
 * reaction-role menu message, catching any adds/removes that happened while offline.
 */
async function syncReactionRoles() {
    const activeMessageId = getActiveMessageId();
    if (!activeMessageId) {
        console.log("No active reaction message ID found to sync.");
        return;
    }

    console.log("Checking for reactions changed while offline...");
    try {
        for (const channelId of ALLOWED_CHANNELS) {
            const channel = await discordClient.channels
                .fetch(channelId)
                .catch(() => null);
            if (!channel || !channel.isTextBased()) continue;

            const targetMessage = await channel.messages
                .fetch(activeMessageId)
                .catch(() => null);
            if (!targetMessage) continue;

            console.log(
                `Found active menu message [${activeMessageId}]. Syncing additions and removals...`,
            );

            // Track which users currently have each role's reaction active
            const activeReactorsByRole = {};
            for (const roleId of Object.values(EMOJI_ROLE_MAP)) {
                activeReactorsByRole[roleId] = new Set();
            }

            for (const reaction of targetMessage.reactions.cache.values()) {
                const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
                if (!roleId) continue; // Skip unmapped emojis

                // Handle pagination in case a post gets more than 100 reactions
                const reactors = await reaction.users.fetch({ limit: 100 });
                for (const user of reactors.values()) {
                    if (!user.bot) activeReactorsByRole[roleId].add(user.id);
                }
            }

            const guildMembers = await targetMessage.guild.members.fetch();

            for (const roleId of Object.values(EMOJI_ROLE_MAP)) {
                const activeReactors = activeReactorsByRole[roleId];

                for (const member of guildMembers.values()) {
                    if (member.user.bot) continue;

                    const hasRole = member.roles.cache.has(roleId);
                    const hasReaction = activeReactors.has(member.id);

                    if (hasReaction && !hasRole) {
                        await member.roles.add(roleId).catch(console.error);
                        console.log(
                            `Sync: granted missed role ${roleId} (${ROLE_KEYWORDS[roleId]}) to ${member.user.tag}`,
                        );
                    } else if (!hasReaction && hasRole) {
                        await member.roles.remove(roleId).catch(console.error);
                        console.log(
                            `Sync: removed stale role ${roleId} (${ROLE_KEYWORDS[roleId]}) from ${member.user.tag}`,
                        );
                    }
                }
            }
            break; // Only one channel should have the active menu message
        }
        console.log("Offline reaction sync complete.");
    } catch (error) {
        console.error("Failed offline reaction sync:", error);
    }
}

/**
 * Builds the reaction-role menu embed from the current REACTION_ROLES list.
 */
function buildReactionRoleEmbed() {
    return new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle("Select Your Notification Roles")
        .setDescription(
            "React to this message with the emojis below to opt-in or opt-out of specific community deal pings!",
        )
        .addFields(
            REACTION_ROLES.map(({ emojiName, emojiId, label }) => ({
                name: label,
                value: `React with <:${emojiName}:${emojiId}> to get notified for ${label} deals.`,
            })),
        )
        .setFooter({ text: "Remove your reaction at any time to remove the role." })
        .setTimestamp();
}

/**
 * Posts (or refreshes) the reaction-role menu in the given channel: edits the existing menu
 * message in place if one exists there, otherwise posts and tracks a new one. Either way,
 * every currently configured emoji gets reacted onto the message.
 */
async function refreshReactionRoleMenu(channel) {
    const reactionEmbed = buildReactionRoleEmbed();
    const existingMessageId = getActiveMessageId();

    if (existingMessageId) {
        try {
            const existingMessage = await channel.messages.fetch(existingMessageId);
            await existingMessage.edit({ embeds: [reactionEmbed] });

            // React() is a no-op if the bot already reacted, so this only adds newly configured emojis
            for (const emojiId of Object.keys(EMOJI_ROLE_MAP)) {
                await existingMessage.react(emojiId);
            }

            return { message: existingMessage, created: false };
        } catch (error) {
            // Unknown Message means it was deleted/never existed here; anything else (e.g.
            // missing permissions) is worth surfacing instead of silently duplicating the post
            if (error.code === 10008) {
                console.log(
                    `Previous reaction message (${existingMessageId}) not found in this channel; posting a new one.`,
                );
            } else {
                console.error(
                    `Failed to fetch/edit existing reaction message (${existingMessageId}):`,
                    error,
                );
            }
        }
    }

    const newMessage = await channel.send({ embeds: [reactionEmbed] });
    fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ reactionMessageId: newMessage.id }, null, 2),
    );
    console.log(`Saved new reactionMessageId to config.json: ${newMessage.id}`);

    for (const emojiId of Object.keys(EMOJI_ROLE_MAP)) {
        await newMessage.react(emojiId);
    }

    return { message: newMessage, created: true };
}

// Handles the setup-roles, toonie-math-time, math-time-open, say, and add-reaction-role slash commands
discordClient.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "say") {
        if (interaction.user.id !== SAY_COMMAND_USER_ID) {
            await interaction.reply({
                content: "You are not allowed to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const targetChannel =
            interaction.options.getChannel("channel") || interaction.channel;
        const messageText = interaction.options.getString("message", true);

        try {
            await targetChannel.send(messageText);
            await interaction.reply({
                content: `Message sent in ${targetChannel}.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error("Failed to send message via /say:", error);
            await interaction.reply({
                content:
                    "Failed to send that message — check the channel and my permissions there.",
                flags: MessageFlags.Ephemeral,
            });
        }
        return;
    }

    if (interaction.commandName === "toonie-math-time") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await postMathChallenge(interaction.channel);
        await interaction.editReply({ content: "Math challenge posted!" });
        return;
    }

    if (interaction.commandName === "math-time-open") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await postMathChallenge(interaction.channel, null);
        await interaction.editReply({ content: "Math challenge posted!" });
        return;
    }

    if (interaction.commandName === "add-reaction-role") {
        if (!interaction.member.permissions.has("Administrator")) {
            await interaction.reply({
                content: "You must be an Administrator to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const emojiInput = interaction.options.getString("emoji", true).trim();
        const label = interaction.options.getString("label", true).trim();
        const keywordsInput = interaction.options.getString("keywords", true);
        let role = interaction.options.getRole("role");

        const keywords = keywordsInput
            .split(",")
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean);
        if (keywords.length === 0) {
            await interaction.editReply({
                content: "Please provide at least one keyword.",
            });
            return;
        }

        const emojiMatch = emojiInput.match(/^<a?:(\w+):(\d+)>$/);
        let emojiName, emojiId;

        if (emojiMatch) {
            [, emojiName, emojiId] = emojiMatch;
        } else if (/^\d+$/.test(emojiInput)) {
            // Bare numeric ID: look up the actual emoji in this server to get its name
            const guildEmoji = interaction.guild.emojis.cache.get(emojiInput);
            if (!guildEmoji) {
                await interaction.editReply({
                    content:
                        "I couldn't find a custom emoji with that ID in this server.",
                });
                return;
            }
            emojiName = guildEmoji.name;
            emojiId = guildEmoji.id;
        } else {
            await interaction.editReply({
                content:
                    "That doesn't look like a custom server emoji. You can paste either the raw mention (type a backslash right before the emoji, e.g. `\\:emojiname:`, and send it to reveal `<:name:id>`) or just the numeric emoji ID.",
            });
            return;
        }

        if (EMOJI_ROLE_MAP[emojiId]) {
            await interaction.editReply({
                content: "That emoji is already mapped to a role.",
            });
            return;
        }

        if (role) {
            if (role.id === interaction.guild.id) {
                await interaction.editReply({
                    content: "You can't use @everyone as a reaction role.",
                });
                return;
            }
            if (role.managed) {
                await interaction.editReply({
                    content:
                        "That role is managed by an integration/bot and can't be manually assigned.",
                });
                return;
            }
            if (REACTION_ROLES.some((entry) => entry.roleId === role.id)) {
                await interaction.editReply({
                    content: "That role is already mapped to a different emoji.",
                });
                return;
            }
        } else {
            const newRoleName = `${keywords[0].toUpperCase()} (Wario64 Deals)`;
            try {
                role = await interaction.guild.roles.create({
                    name: newRoleName,
                    reason: `Created via /add-reaction-role by ${interaction.user.tag}`,
                });
            } catch (error) {
                console.error(
                    "Failed to create new role via /add-reaction-role:",
                    error,
                );
                await interaction.editReply({
                    content:
                        "Failed to create a new role \u2014 make sure I have the Manage Roles permission.",
                });
                return;
            }
        }

        const botMember = await interaction.guild.members.fetchMe();
        if (botMember.roles.highest.position <= role.position) {
            await interaction.editReply({
                content:
                    "My highest role needs to be above that role for me to assign it. Move my role higher in the role list and try again.",
            });
            return;
        }

        const newEntry = { emojiName, emojiId, roleId: role.id, label, keywords };
        REACTION_ROLES.push(newEntry);
        fs.writeFileSync(
            REACTION_ROLES_PATH,
            JSON.stringify(REACTION_ROLES, null, 2),
        );
        rebuildRoleLookups();

        try {
            const { message, created } = await refreshReactionRoleMenu(
                interaction.channel,
            );
            const menuStatus = created
                ? `New role menu posted! (${message.id})`
                : `Existing role menu updated! ${message.url}`;
            await interaction.editReply({
                content: `Added "${label}" (<:${emojiName}:${emojiId}> \u2192 <@&${role.id}>). ${menuStatus}`,
            });
        } catch (error) {
            console.error(
                "Failed to refresh reaction role menu after adding a role:",
                error,
            );
            await interaction.editReply({
                content: `Added "${label}", but couldn't refresh the posted menu automatically \u2014 run /setup-roles to update it.`,
            });
        }
        return;
    }

    if (interaction.commandName === "haunt") {
        if (interaction.user.id !== SAY_COMMAND_USER_ID) {
            await interaction.reply({
                content: "You are not allowed to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const targetUser = interaction.options.getUser("target", true);
        const customMessage = interaction.options.getString("message");
        const hauntingMessage =
            customMessage ||
            HAUNTING_MESSAGES[randomInt(0, HAUNTING_MESSAGES.length - 1)];

        try {
            const channel = await discordClient.channels.fetch(
                CURSED_GENERAL_CHANNEL_ID
            );
            if (!channel) {
                await interaction.reply({
                    content: "Cursed general channel not found.",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await channel.send({
                content: `<@${targetUser.id}> ${hauntingMessage}`,
                flags: MessageFlags.Ephemeral,
            });

            await interaction.reply({
                content: `The shadows have whispered to ${targetUser.username}...`,
                flags: MessageFlags.Ephemeral,
            });
            console.log(
                `Sent haunting message to ${targetUser.tag}: "${hauntingMessage}"`
            );
        } catch (error) {
            console.error("Failed to send haunting message:", error);
            await interaction.reply({
                content: "Failed to reach the cursed realm...",
                flags: MessageFlags.Ephemeral,
            });
        }
        return;
    }

    if (interaction.commandName === "math-history") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (mathProblemHistory.length === 0) {
            await interaction.editReply({
                content: "No math problems have been posted yet during this session.",
            });
            return;
        }

        // Build a formatted list of problems
        let historyText = `**Math Problem History** (${mathProblemHistory.length} total)\n\n`;
        
        // Show the last 10 problems to avoid message length limits
        const recentProblems = mathProblemHistory.slice(-10);
        for (let i = 0; i < recentProblems.length; i++) {
            const problem = recentProblems[i];
            const index = mathProblemHistory.length - recentProblems.length + i + 1;
            const time = new Date(problem.timestamp).toLocaleTimeString();
            historyText += `**#${index}** (${time})\n`;
            historyText += `${problem.prompt}\n`;
            historyText += `\`\`\`\n${problem.problem}\n\`\`\`\n`;
            historyText += `**Answer:** ${problem.answer}\n\n`;
        }

        if (mathProblemHistory.length > 10) {
            historyText += `*Showing last 10 of ${mathProblemHistory.length} problems*`;
        }

        await interaction.editReply({
            content: historyText,
        });
        return;
    }

    if (interaction.commandName === "spanish-quiz") {
        await interaction.deferReply();
        await postSpanishQuiz(interaction.channel);
        await interaction.editReply({ content: "Spanish quiz question posted!" });
        return;
    }

    if (interaction.commandName === "spanish-history") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (spanishQuizHistory.length === 0) {
            await interaction.editReply({
                content: "No Spanish quiz questions have been posted yet during this session.",
            });
            return;
        }

        // Build a formatted list of questions
        let historyText = `**Spanish Quiz History** (${spanishQuizHistory.length} total)\n\n`;
        
        // Show the last 10 questions to avoid message length limits
        const recentQuestions = spanishQuizHistory.slice(-10);
        for (let i = 0; i < recentQuestions.length; i++) {
            const question = recentQuestions[i];
            const index = spanishQuizHistory.length - recentQuestions.length + i + 1;
            const time = new Date(question.timestamp).toLocaleTimeString();
            historyText += `**#${index}** (${time})\n`;
            historyText += `${question.question}\n`;
            const optionsText = question.options
                .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
                .join(" | ");
            historyText += `${optionsText}\n`;
            historyText += `**Answer:** ${question.answer}\n\n`;
        }

        if (spanishQuizHistory.length > 10) {
            historyText += `*Showing last 10 of ${spanishQuizHistory.length} questions*`;
        }

        await interaction.editReply({
            content: historyText,
        });
        return;
    }

    if (interaction.commandName !== "setup-roles") return;

    if (!interaction.member.permissions.has("Administrator")) {
        await interaction.reply({
            content: "You must be an Administrator to use this command.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const { message, created } = await refreshReactionRoleMenu(
            interaction.channel,
        );
        await interaction.editReply({
            content: created
                ? `New role menu posted! (${message.id})`
                : `Existing role menu embed updated! ${message.url}`,
        });
    } catch (error) {
        console.error("Failed to run setup-roles:", error);
        await interaction.editReply({
            content: "An error occurred while managing the menu.",
        });
    }
});

discordClient.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error("Failed fetching partial reaction:", error);
            return;
        }
    }

    if (reaction.message.id !== getActiveMessageId()) return;

    const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
    if (!roleId) return;

    try {
        const member = await reaction.message.guild.members.fetch(user.id);
        await member.roles.add(roleId);
        console.log(
            `Added role ${roleId} (${ROLE_KEYWORDS[roleId]}) to ${user.tag}`,
        );
    } catch (error) {
        console.error("Failed to add role:", error);
    }
});

discordClient.on("messageReactionRemove", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error("Failed fetching partial reaction:", error);
            return;
        }
    }

    if (reaction.message.id !== getActiveMessageId()) return;

    const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
    if (!roleId) return;

    try {
        const member = await reaction.message.guild.members.fetch(user.id);
        await member.roles.remove(roleId);
        console.log(
            `Removed role ${roleId} (${ROLE_KEYWORDS[roleId]}) from ${user.tag}`,
        );
    } catch (error) {
        console.error("Failed to remove role:", error);
    }
});

discordClient.login(DISCORD_BOT_TOKEN);
// Mochabot: watches a BlueSky account and cross-posts new content to a Discord channel,
// runs a keyword-based role-ping chat monitor, and manages reaction-role assignment
// (including reconciling roles against reactions added/removed while offline).

import {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    REST,
    Routes,
} from "discord.js";
import { AtpAgent } from "@atproto/api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config"; // Loads variables from .env into process.env

// Load Spanish quiz questions
let spanishQuestions = [];
try {
    const spanishPath = path.join(__dirname, "spanish.json");
    spanishQuestions = JSON.parse(fs.readFileSync(spanishPath, "utf8"));
    console.log(`Loaded ${spanishQuestions.length} Spanish verb questions`);
} catch (error) {
    console.error("Failed to load Spanish quiz questions:", error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CONFIGURATION ====================

// Discord credentials/targets
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DESTINATION_CHANNEL_ID = process.env.DESTINATION_CHANNEL_ID; // Where BlueSky cross-posts are sent
const CHEAPASSGAMER_THREAD_ID = process.env.CHEAPASSGAMER_THREAD_ID; // Thread for cheapassgamer.com posts

// BlueSky login used to read the feed (needs an app password, not the main account password)
const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD;

// BlueSky accounts whose posts get mirrored to Discord
const TARGET_BLUESKY_USERS = [
    process.env.TARGET_BLUESKY_USER,
    "cheapassgamer.com",
];

// How often to poll BlueSky for new posts, in milliseconds
const POLL_INTERVAL_MS = 60000;

// Track the last processed URI for each BlueSky user
const lastProcessedUriMap = {};

// Flavor text shown before the role pings on a cross-posted BlueSky message; one is picked at random
const ROLE_PING_MESSAGES = [
    "TO ME, MY NIGGAS!",
    "which one of you home of sexuals asked for this?",
    "peep this shit cuz.",
    "you got like twenty seconds bro gl",
    "meow meow meow meow meow meow meow bitch meow",
    "quieres?",
    "who wallet got pocket lint and a dream in it cuz...",
    "uwu nyaaaa owo you broke bitch",
    "donate 3 dollars to [synnie's ko-fi](https://ko-fi.com/synnie) to keep me alive i'm so hungry",
    "neko neko beeeeeeeeam",
    "do u mind i am grooming",
    "FOCUS, M!!!",
    "You were excited for this deal until you noticed you only have one rupee in your pocket..."
];

// Only this user may run /say
const SAY_COMMAND_USER_ID = "116938174823006209";

// Developer reminder settings: ping the developer every 28 days
const DEVELOPER_USER_ID = process.env.DEVELOPER_USER_ID || SAY_COMMAND_USER_ID;
const DEVELOPER_REMINDER_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

// Chat keyword monitor settings
const ALLOWED_CHANNELS = ["121721532551528448", "1548135439829835906"];

// Cursed general channel for secret messages
const CURSED_GENERAL_CHANNEL_ID = process.env.CURSED_GENERAL_CHANNEL_ID;

// Haunting messages to send secretly to users
const HAUNTING_MESSAGES = [
    "they know what you did.",
    "the walls are watching.",
    "your secrets are safe... for now.",
    "we remember.",
    "you can't escape what you've become.",
    "the shadows whisper your name.",
    "time moves differently here.",
    "you were never alone.",
    "they're coming for you.",
    "the void calls.",
    "your reflection doesn't match anymore.",
    "sleep is not an escape.",
];

// Auto-haunting settings: randomly haunt users at random times
const AUTO_HAUNT_ENABLED = process.env.AUTO_HAUNT_ENABLED === "true";
const AUTO_HAUNT_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours minimum
const AUTO_HAUNT_MAX_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours maximum
const AUTO_HAUNT_ROLE_ID = "441290984542699521"; // Regulars role

// Role settings: all reaction roles (emoji, role ID, embed label, keywords) live in
// custom-reaction-roles.json instead of here, to keep this file compact. Edit that file
// directly, or use /add-reaction-role, to add/remove entries. KEYWORD_ROLES, EMOJI_ROLE_MAP,
// the setup-roles embed, and its reactions are all generated from the loaded list.
const REACTION_ROLES_PATH = path.join(__dirname, "custom-reaction-roles.json");

function loadReactionRoles() {
    try {
        if (fs.existsSync(REACTION_ROLES_PATH)) {
            return JSON.parse(fs.readFileSync(REACTION_ROLES_PATH, "utf8"));
        }
    } catch (error) {
        console.error("Could not read custom-reaction-roles.json:", error);
    }
    return [];
}

let REACTION_ROLES = loadReactionRoles();

// Derived lookups; recomputed by rebuildRoleLookups() whenever REACTION_ROLES changes
let EMOJI_ROLE_MAP = {};
let KEYWORD_ROLES = {};
let ROLE_KEYWORDS = {};

function rebuildRoleLookups() {
    // emoji ID -> role ID, used by the reaction add/remove handlers and the offline sync
    EMOJI_ROLE_MAP = Object.fromEntries(
        REACTION_ROLES.map(({ emojiId, roleId }) => [emojiId, roleId]),
    );

    // keyword -> role ID, used by the chat keyword monitor and BlueSky cross-post pings
    KEYWORD_ROLES = Object.fromEntries(
        REACTION_ROLES.flatMap(({ keywords, roleId }) =>
            keywords.map((keyword) => [keyword, roleId]),
        ),
    );

    // role ID -> keywords, used purely for logging so logs show what role changed
    ROLE_KEYWORDS = Object.fromEntries(
        REACTION_ROLES.map(({ keywords, roleId }) => [roleId, keywords.join("/")]),
    );
}
rebuildRoleLookups();

// Math quiz settings: periodically challenges a user with a simple algebra equation
const MATH_QUIZ_CHANNEL_ID = process.env.MATH_QUIZ_CHANNEL_ID;
const MATH_QUIZ_USER_ID = process.env.MATH_QUIZ_USER_ID;
const MATH_QUIZ_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Guild the slash commands (/setup-roles, /toonie-math-time) are scoped to, instead of registering them globally
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID;

// Persists the ID of the posted reaction-role menu message across restarts
const CONFIG_PATH = path.join(__dirname, "config.json");

// Track when the last developer reminder was sent
let lastDeveloperReminderTime = 0;

function loadLastReminderTime() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
            return config.lastDeveloperReminderTime || 0;
        }
    } catch (error) {
        console.error("Could not read config.json for reminder time:", error);
    }
    return 0;
}

function saveLastReminderTime() {
    try {
        let config = {};
        if (fs.existsSync(CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        }
        config.lastDeveloperReminderTime = Date.now();
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error("Could not save reminder time to config.json:", error);
    }
}

lastDeveloperReminderTime = loadLastReminderTime();
// =======================================================

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const atpAgent = new AtpAgent({
    service: "https://bsky.social",
});

// Posted math challenges awaiting a reply: message ID -> { answer, userId }
const activeMathChallenges = new Map();

// Storage for math problem history: tracks all problems posted during this session
// Format: { timestamp, messageId, problem, answer, prompt }
const mathProblemHistory = [];

// Map of message IDs to their problem records for quick lookup
const problemsByMessageId = new Map();

// Posted Spanish quiz challenges awaiting a reply: message ID -> { answer, userId }
const activeSpanishChallenges = new Map();

// Storage for Spanish quiz history: tracks all questions posted during this session
// Format: { timestamp, messageId, question, answer, options, prompt }
const spanishQuizHistory = [];

// Map of message IDs to their Spanish question records for quick lookup
const spanishQuestionsByMessageId = new Map();

// Scoped to COMMAND_GUILD_ID (guild commands update instantly, unlike global ones)
const guildSlashCommands = [
    new SlashCommandBuilder()
        .setName("setup-roles")
        .setDescription(
            "Posts the custom reaction role embed in the current channel.",
        ),
    new SlashCommandBuilder()
        .setName("toonie-math-time")
        .setDescription("Posts a random algebra equation for Toonie to solve."),
    new SlashCommandBuilder()
        .setName("math-time-open")
        .setDescription(
            "Posts a random algebra equation open for anyone to solve.",
        ),
    new SlashCommandBuilder()
        .setName("say")
        .setDescription(
            "Makes the bot post a message (Synnie only, screw you guys).",
        )
        .addStringOption((option) =>
            option
                .setName("message")
                .setDescription("The message for the bot to post")
                .setRequired(true),
        )
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("Channel to post in (defaults to the current channel)")
                .setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName("add-reaction-role")
        .setDescription(
            "Adds a new reaction role to the menu (Administrator only).",
        )
        .addStringOption((option) =>
            option
                .setName("emoji")
                .setDescription(
                    "The custom server emoji: paste its raw mention (\\:name:) or just its numeric ID",
                )
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("label")
                .setDescription("Display name shown in the role menu embed")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("keywords")
                .setDescription(
                    "Comma-separated keywords that also ping this role in chat/BlueSky posts",
                )
                .setRequired(true),
        )
        .addRoleOption((option) =>
            option
                .setName("role")
                .setDescription(
                    "The role to grant (leave blank to create a new role automatically)",
                )
                .setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName("haunt")
        .setDescription(
            "Send a haunting secret message to a user in cursed general (Synnie only).",
        )
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("The user to haunt")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option
                .setName("message")
                .setDescription("Custom haunting message (optional, random if not provided)")
                .setRequired(false),
        ),
    new SlashCommandBuilder()
        .setName("math-history")
        .setDescription("View all math problems posted during this session."),
    new SlashCommandBuilder()
        .setName("spanish-quiz")
        .setDescription("Posts a random Spanish verb conjugation question."),
    new SlashCommandBuilder()
        .setName("spanish-history")
        .setDescription("View all Spanish quiz questions posted during this session."),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

discordClient.once("clientReady", async () => {
    console.log(`Logged in as ${discordClient.user.tag}`);

    try {
        // Clears any stale global commands from before commands were switched to guild-scoped
        await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
        await rest.put(
            Routes.applicationGuildCommands(DISCORD_CLIENT_ID, COMMAND_GUILD_ID),
            { body: guildSlashCommands },
        );
        console.log("Slash commands registered.");
    } catch (error) {
        console.error("Error registering slash commands:", error);
    }

    try {
        await atpAgent.login({
            identifier: BLUESKY_HANDLE,
            password: BLUESKY_APP_PASSWORD,
        });
        console.log("Successfully logged into BlueSky!");
        console.log(`Watching BlueSky users: ${TARGET_BLUESKY_USERS.join(", ")}`);
        setInterval(checkBlueSkyPosts, POLL_INTERVAL_MS);
        await checkBlueSkyPosts(); // Run once immediately instead of waiting for the first interval
    } catch (error) {
        console.error("Failed to login to BlueSky:", error);
    }

    setInterval(postScheduledMathChallenge, MATH_QUIZ_INTERVAL_MS);

    // Check for 28-day developer reminder every hour
    setInterval(sendDeveloperReminder, 60 * 60 * 1000);

    // Start auto-haunting if enabled
    if (AUTO_HAUNT_ENABLED) {
        console.log("Auto-haunting enabled. Scheduling first haunt...");
        scheduleAutoHaunt();
    }

    await syncReactionRoles();
});

/**
 * Generates a random math question: polynomial, factoring, series, or functions.
 */
function generateAlgebraEquation() {
    const questionType = randomInt(0, 3);
    switch (questionType) {
        case 0:
            return generateComplexPolynomial();
        case 1:
            return generateFactoringQuadratic();
        case 2:
            return generateNumberSeries();
        case 3:
            return generateFunctionAnalysis();
        default:
            return generateComplexPolynomial();
    }
}

/**
 * Generates a complex polynomial equation of degree 3 or 4 with integer coefficients.
 * Returns an equation in the form ax^n + bx^(n-1) + ... = 0 with at least one integer root.
 */
function generateComplexPolynomial() {
    const degree = randomInt(3, 4); // Degree 3 or 4
    const root1 = randomNonZeroInt(-5, 5);
    const root2 = randomNonZeroInt(-5, 5);
    const root3 = randomNonZeroInt(-5, 5);
    
    let roots = [root1, root2, root3];
    let coefficients;

    if (degree === 4) {
        const root4 = randomNonZeroInt(-5, 5);
        roots.push(root4);
        // Expand (x - root1)(x - root2)(x - root3)(x - root4)
        coefficients = expandPolynomial([
            [1, -root1],
            [1, -root2],
            [1, -root3],
            [1, -root4],
        ]);
    } else {
        // Expand (x - root1)(x - root2)(x - root3)
        coefficients = expandPolynomial([
            [1, -root1],
            [1, -root2],
            [1, -root3],
        ]);
    }

    // Build equation string
    let equationParts = [];
    for (let i = 0; i < coefficients.length; i++) {
        const coeff = coefficients[i];
        const power = coefficients.length - 1 - i;

        if (coeff === 0) continue;

        let term = "";
        if (equationParts.length > 0) {
            term += coeff > 0 ? " + " : " - ";
            term += Math.abs(coeff);
        } else {
            term += coeff;
        }

        if (power > 1) {
            term += `x^${power}`;
        } else if (power === 1) {
            term += "x";
        }

        equationParts.push(term);
    }

    const equation = equationParts.join("") + " = 0";
    const uniqueRoots = [...new Set(roots)].sort((a, b) => a - b);
    const answer = uniqueRoots.map((root) => `x = ${root}`).join(" or ");

    return {
        equation,
        answer,
        prompt: "Find all integer roots:",
    };
}

/**
 * Expands a product of linear polynomials.
 * Each polynomial is represented as [coefficient, constant] for (coeff*x + constant).
 */
function expandPolynomial(polynomials) {
    let result = [1]; // Start with the constant 1

    for (const [coeff, constant] of polynomials) {
        const newResult = new Array(result.length + 1).fill(0);
        for (let i = 0; i < result.length; i++) {
            newResult[i] += result[i] * coeff; // Multiply by coeff*x
            newResult[i + 1] += result[i] * constant; // Multiply by constant
        }
        result = newResult;
    }

    return result;
}

/**
 * Generates a quadratic equation in the form ax^2 + bx + c = 0 that factors nicely.
 * The user must factor it into the form (px + q)(rx + s) = 0.
 */
function generateFactoringQuadratic() {
    // Generate two linear factors: (ax + b)(cx + d)
    const a = randomNonZeroInt(-3, 3);
    const b = randomNonZeroInt(-5, 5);
    const c = randomNonZeroInt(-3, 3);
    const d = randomNonZeroInt(-5, 5);

    // Expand (ax + b)(cx + d) = acx^2 + (ad + bc)x + bd
    const A = a * c;
    const B = a * d + b * c;
    const C = b * d;

    // Format the equation
    let equationParts = [];

    if (A !== 0) {
        equationParts.push(A === 1 ? "x^2" : A === -1 ? "-x^2" : `${A}x^2`);
    }

    if (B !== 0) {
        const sign = B > 0 ? " + " : " - ";
        equationParts.push(sign + (Math.abs(B) === 1 ? "x" : `${Math.abs(B)}x`));
    }

    if (C !== 0) {
        const sign = C > 0 ? " + " : " - ";
        equationParts.push(sign + Math.abs(C));
    }

    const equation = equationParts.join("") + " = 0";

    // Format the factored form for the answer
    const factor1 = a === 1 ? `x + ${b}` : a === -1 ? `-x + ${b}` : `${a}x + ${b}`;
    const factor2 = c === 1 ? `x + ${d}` : c === -1 ? `-x + ${d}` : `${c}x + ${d}`;
    const factored = `(${factor1})(${factor2})`;

    // Calculate the roots for verification
    const root1 = -b / a;
    const root2 = -d / c;

    return {
        equation,
        answer: factored,
        prompt: "Factor the quadratic:",
    };
}

/**
 * Generates a challenging number series problem with various patterns.
 * Patterns include: polynomial sequences, Fibonacci-like, geometric with twist, etc.
 */
function generateNumberSeries() {
    const seriesType = randomInt(0, 4);
    let series, nextNumber, pattern;

    switch (seriesType) {
        case 0:
            // Quadratic sequence: differences of differences are constant
            return generateQuadraticSequence();
        case 1:
            // Cubic sequence: third differences are constant
            return generateCubicSequence();
        case 2:
            // Fibonacci-like with multiplier: a(n) = a(n-1) + 2*a(n-2)
            return generateFibonacciVariant();
        case 3:
            // Geometric sequence with arithmetic twist
            return generateGeometricWithTwist();
        case 4:
            // Prime-based or factorial-based sequence
            return generateAdvancedSequence();
        default:
            return generateQuadraticSequence();
    }
}

/**
 * Generates a quadratic sequence (second differences constant).
 * Example: 2, 5, 10, 17, 26, ? → differences: 3, 5, 7, 9 (constant diff of 2)
 */
function generateQuadraticSequence() {
    const a = randomNonZeroInt(-3, 3); // Coefficient of n^2
    const b = randomNonZeroInt(-5, 5); // Coefficient of n
    const c = randomNonZeroInt(-5, 5); // Constant

    const series = [];
    for (let n = 1; n <= 6; n++) {
        series.push(a * n * n + b * n + c);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates a cubic sequence (third differences constant).
 * Much harder than quadratic.
 */
function generateCubicSequence() {
    const a = randomNonZeroInt(-2, 2); // Coefficient of n^3
    const b = randomNonZeroInt(-3, 3); // Coefficient of n^2
    const c = randomNonZeroInt(-3, 3); // Coefficient of n
    const d = randomNonZeroInt(-5, 5); // Constant

    const series = [];
    for (let n = 1; n <= 6; n++) {
        series.push(a * n * n * n + b * n * n + c * n + d);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates a Fibonacci-like sequence with a twist.
 * a(n) = a(n-1) + k*a(n-2) where k is a random multiplier.
 */
function generateFibonacciVariant() {
    const k = randomNonZeroInt(-3, 3);
    const start1 = randomInt(1, 5);
    const start2 = randomInt(1, 5);

    const series = [start1, start2];
    for (let i = 2; i < 6; i++) {
        series.push(series[i - 1] + k * series[i - 2]);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates a geometric sequence with an arithmetic twist.
 * Example: multiply by r, then add/subtract a constant each step.
 */
function generateGeometricWithTwist() {
    const r = randomNonZeroInt(-3, 3); // Multiplier
    const twist = randomNonZeroInt(-5, 5); // Arithmetic twist
    const start = randomInt(1, 3);

    const series = [start];
    for (let i = 1; i < 6; i++) {
        series.push(series[i - 1] * r + twist);
    }

    const answer = series[5];
    const displaySeries = series.slice(0, 5).join(", ");

    return {
        equation: displaySeries + ", ?",
        answer: String(answer),
        prompt: "Find the next number in the sequence:",
    };
}

/**
 * Generates an advanced sequence based on primes, factorials, or combined patterns.
 */
function generateAdvancedSequence() {
    const advancedType = randomInt(0, 2);

    if (advancedType === 0) {
        // Factorial-based: n! + n, n! - n, etc.
        const factorials = [1, 2, 6, 24, 120, 720];
        const operation = randomInt(0, 2);
        const series = factorials.map((f, i) => {
            const n = i + 1;
            if (operation === 0) return f + n;
            if (operation === 1) return f - n;
            return f * n;
        });

        const answer = series[5];
        const displaySeries = series.slice(0, 5).join(", ");

        return {
            equation: displaySeries + ", ?",
            answer: String(answer),
            prompt: "Find the next number in the sequence:",
        };
    } else if (advancedType === 1) {
        // Powers with offset: 2^n + n^2, 3^n - n, etc.
        const base = randomInt(2, 4);
        const operation = randomInt(0, 1);
        const series = [];
        for (let n = 1; n <= 6; n++) {
            if (operation === 0) {
                series.push(Math.pow(base, n) + n * n);
            } else {
                series.push(Math.pow(base, n) - n);
            }
        }

        const answer = series[5];
        const displaySeries = series.slice(0, 5).join(", ");

        return {
            equation: displaySeries + ", ?",
            answer: String(answer),
            prompt: "Find the next number in the sequence:",
        };
    } else {
        // Alternating pattern with increasing complexity
        const series = [];
        for (let n = 1; n <= 6; n++) {
            if (n % 2 === 1) {
                series.push(n * n * n); // Odd positions: cubes
            } else {
                series.push(n * (n + 1)); // Even positions: n(n+1)
            }
        }

        const answer = series[5];
        const displaySeries = series.slice(0, 5).join(", ");

        return {
            equation: displaySeries + ", ?",
            answer: String(answer),
            prompt: "Find the next number in the sequence:",
        };
    }
}

/**
 * Generates a function analysis problem.
 * Types: find domain, find range, find critical points, find asymptotes, etc.
 */
function generateFunctionAnalysis() {
    const analysisType = randomInt(0, 4);

    switch (analysisType) {
        case 0:
            return generateDomainProblem();
        case 1:
            return generateRangeProblem();
        case 2:
            return generateCriticalPointsProblem();
        case 3:
            return generateAsymptoteProblem();
        case 4:
            return generateCompositionProblem();
        default:
            return generateDomainProblem();
    }
}

/**
 * Find the domain of a function (where it's defined).
 */
function generateDomainProblem() {
    const domainType = randomInt(0, 3);
    let func, answer, explanation;

    if (domainType === 0) {
        // Rational function: f(x) = 1/(x - a)
        const a = randomNonZeroInt(-5, 5);
        func = `f(x) = 1/(x - ${a})`;
        answer = `x ≠ ${a}` + (a > 0 ? ` or (-∞, ${a}) ∪ (${a}, ∞)` : ` or (-∞, ${a}) ∪ (${a}, ∞)`);
    } else if (domainType === 1) {
        // Square root: f(x) = √(x - a)
        const a = randomNonZeroInt(-5, 5);
        func = `f(x) = √(x - ${a})`;
        answer = `x ≥ ${a}` + (a > 0 ? ` or [${a}, ∞)` : ` or [${a}, ∞)`);
    } else if (domainType === 2) {
        // Rational with quadratic denominator: f(x) = 1/(x² - a)
        const a = randomInt(1, 5);
        const sqrtA = Math.sqrt(a);
        func = `f(x) = 1/(x² - ${a})`;
        answer = `x ≠ ±${sqrtA}` + (Number.isInteger(sqrtA) ? ` or ℝ \\ {-${sqrtA}, ${sqrtA}}` : "");
    } else {
        // Logarithm: f(x) = ln(x - a)
        const a = randomNonZeroInt(-5, 5);
        func = `f(x) = ln(x - ${a})`;
        answer = `x > ${a}` + (a > 0 ? ` or (${a}, ∞)` : ` or (${a}, ∞)`);
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Find the domain:",
    };
}

/**
 * Find the range of a function (all possible output values).
 */
function generateRangeProblem() {
    const rangeType = randomInt(0, 2);
    let func, answer;

    if (rangeType === 0) {
        // Quadratic: f(x) = a(x - h)² + k (vertex form)
        const a = randomNonZeroInt(-3, 3);
        const h = randomNonZeroInt(-3, 3);
        const k = randomNonZeroInt(-5, 5);
        const sign = a > 0 ? "≥" : "≤";
        func = `f(x) = ${a}(x - ${h})² + ${k}`;
        answer = `y ${sign} ${k}` + (a > 0 ? ` or [${k}, ∞)` : ` or (-∞, ${k}]`);
    } else if (rangeType === 1) {
        // Rational: f(x) = (ax + b)/(x + c) has horizontal asymptote
        const a = randomNonZeroInt(-3, 3);
        const b = randomNonZeroInt(-5, 5);
        const c = randomNonZeroInt(-5, 5);
        func = `f(x) = (${a}x + ${b})/(x + ${c})`;
        answer = `y ≠ ${a}` + ` or ℝ \\ {${a}}`;
    } else {
        // Exponential: f(x) = a·b^x + c
        const a = randomInt(1, 3);
        const b = randomInt(2, 4);
        const c = randomNonZeroInt(-3, 3);
        const sign = c > 0 ? ">" : "<";
        func = `f(x) = ${a}·${b}^x + ${c}`;
        answer = `y ${sign} ${c}` + (c > 0 ? ` or (${c}, ∞)` : ` or (-∞, ${c})`);
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Find the range:",
    };
}

/**
 * Find critical points (where derivative = 0 or undefined).
 */
function generateCriticalPointsProblem() {
    const a = randomNonZeroInt(-3, 3);
    const b = randomNonZeroInt(-5, 5);
    const c = randomNonZeroInt(-5, 5);

    // f(x) = ax³ + bx² + cx
    // f'(x) = 3ax² + 2bx + c
    // Critical points where f'(x) = 0

    const discriminant = 4 * b * b - 12 * a * c;
    let answer;

    if (discriminant < 0) {
        answer = "No real critical points";
    } else if (discriminant === 0) {
        const x = (-2 * b) / (6 * a);
        answer = `x = ${x}`;
    } else {
        const sqrtDisc = Math.sqrt(discriminant);
        const x1 = ((-2 * b + sqrtDisc) / (6 * a)).toFixed(2);
        const x2 = ((-2 * b - sqrtDisc) / (6 * a)).toFixed(2);
        answer = `x = ${x1}, x = ${x2}`;
    }

    const func = `f(x) = ${a}x³ + ${b}x² + ${c}x`;

    return {
        equation: func,
        answer: answer,
        prompt: "Find the critical points:",
    };
}

/**
 * Find vertical and horizontal asymptotes.
 */
function generateAsymptoteProblem() {
    const asymptoteType = randomInt(0, 1);
    let func, answer;

    if (asymptoteType === 0) {
        // Vertical asymptotes from denominator zeros
        const a = randomNonZeroInt(-3, 3);
        const b = randomNonZeroInt(-3, 3);
        const c = randomNonZeroInt(-5, 5);
        func = `f(x) = (${a}x + ${b})/((x - ${c})(x + ${c}))`;
        answer = `Vertical: x = ${c}, x = -${c}; Horizontal: y = 0`;
    } else {
        // Horizontal asymptotes from degree comparison
        const a = randomNonZeroInt(-3, 3);
        const b = randomNonZeroInt(-3, 3);
        const c = randomNonZeroInt(1, 3);
        const d = randomNonZeroInt(1, 3);
        func = `f(x) = (${a}x² + ${b}x)/(${c}x² + ${d})`;
        const horizontalAsymptote = (a / c).toFixed(2);
        answer = `Vertical: x = 0; Horizontal: y = ${horizontalAsymptote}`;
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Find the asymptotes:",
    };
}

/**
 * Find the composition of two functions.
 */
function generateCompositionProblem() {
    const a = randomNonZeroInt(-3, 3);
    const b = randomNonZeroInt(-5, 5);
    const c = randomNonZeroInt(-3, 3);
    const d = randomNonZeroInt(-5, 5);

    // f(x) = ax + b
    // g(x) = cx + d
    // Find f(g(x)) or g(f(x))

    const compositionType = randomInt(0, 1);
    let func, answer;

    if (compositionType === 0) {
        // f(g(x))
        const coeff = a * c;
        const constant = a * d + b;
        func = `f(x) = ${a}x + ${b}, g(x) = ${c}x + ${d}. Find f(g(x)):`;
        answer = `f(g(x)) = ${coeff}x + ${constant}`;
    } else {
        // g(f(x))
        const coeff = c * a;
        const constant = c * b + d;
        func = `f(x) = ${a}x + ${b}, g(x) = ${c}x + ${d}. Find g(f(x)):`;
        answer = `g(f(x)) = ${coeff}x + ${constant}`;
    }

    return {
        equation: func,
        answer: answer,
        prompt: "Solve the function composition:",
    };
}

/**
 * Generates a Spanish verb conjugation question from the loaded quiz.
 */
function generateSpanishVerbQuestion() {
    if (spanishQuestions.length === 0) {
        // Fallback if Spanish questions didn't load
        return {
            equation: "Spanish quiz not loaded",
            answer: "Error",
            prompt: "Error:",
        };
    }

    // Pick a random question from the Spanish quiz
    const quizQuestion = spanishQuestions[randomInt(0, spanishQuestions.length - 1)];
    
    // Format the question with options
    const optionsText = quizQuestion.options
        .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
        .join(" | ");
    
    const equation = `${quizQuestion.question}\n${optionsText}`;
    
    // The correct answer is the first option (index 0)
    const correctAnswer = quizQuestion.options[0];

    return {
        equation,
        answer: correctAnswer,
        prompt: "Spanish Verb Conjugation - Choose the correct answer:",
    };
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomNonZeroInt(min, max) {
    let value;
    do {
        value = randomInt(min, max);
    } while (value === 0);
    return value;
}

/**
 * Posts a random algebra equation to the given channel. If targetUserId is set, that user
 * is tagged and is the only one who can reveal the answer by replying; otherwise the
 * challenge is untagged and open for anyone to answer.
 */
async function postMathChallenge(channel, targetUserId = MATH_QUIZ_USER_ID) {
    try {
        if (!channel) {
            console.error("Math quiz channel not found.");
            return;
        }

        const { equation, answer, prompt } = generateAlgebraEquation();
        const mention = targetUserId ? `<@${targetUserId}> ` : "";
        const message = await channel.send(
            `${mention}${prompt}\n\`\`\`\n${equation}\n\`\`\``,
        );
        activeMathChallenges.set(message.id, { answer, userId: targetUserId });
        
        // Store in problem history
        const problemRecord = {
            timestamp: new Date().toISOString(),
            messageId: message.id,
            problem: equation,
            answer: answer,
            prompt: prompt,
        };
        mathProblemHistory.push(problemRecord);
        problemsByMessageId.set(message.id, problemRecord);
        
        console.log(`Math challenge posted (${answer})`);
    } catch (error) {
        console.error("Error posting math challenge:", error);
    }
}

/**
 * Wraps postMathChallenge for the 30-minute timer, which always posts to MATH_QUIZ_CHANNEL_ID
 * regardless of where a slash command might otherwise be run from.
 */
async function postScheduledMathChallenge() {
    const channel = await discordClient.channels
        .fetch(MATH_QUIZ_CHANNEL_ID)
        .catch(() => null);
    await postMathChallenge(channel);
}

/**
 * Posts a random Spanish verb conjugation question to the given channel.
 */
async function postSpanishQuiz(channel) {
    try {
        if (!channel) {
            console.error("Channel not found for Spanish quiz.");
            return;
        }

        if (spanishQuestions.length === 0) {
            await channel.send("Spanish quiz questions not loaded.");
            return;
        }

        const quizQuestion = spanishQuestions[randomInt(0, spanishQuestions.length - 1)];
        const optionsText = quizQuestion.options
            .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
            .join("\n");

        const message = await channel.send(
            `**Spanish Verb Conjugation**\n\n${quizQuestion.question}\n\n${optionsText}`
        );

        activeSpanishChallenges.set(message.id, { answer: quizQuestion.options[0] });

        // Store in quiz history
        const questionRecord = {
            timestamp: new Date().toISOString(),
            messageId: message.id,
            question: quizQuestion.question,
            answer: quizQuestion.options[0],
            options: quizQuestion.options,
            prompt: "Spanish Verb Conjugation",
        };
        spanishQuizHistory.push(questionRecord);
        spanishQuestionsByMessageId.set(message.id, questionRecord);

        console.log(`Spanish quiz question posted (${quizQuestion.options[0]})`);
    } catch (error) {
        console.error("Error posting Spanish quiz:", error);
    }
}

/**
 * Sends a 28-day reminder to the developer via DM, but only if 28 days have passed since the last one.
 */
async function sendDeveloperReminder() {
    const now = Date.now();
    const timeSinceLastReminder = now - lastDeveloperReminderTime;

    // Only send if 28 days have passed
    if (timeSinceLastReminder < DEVELOPER_REMINDER_INTERVAL_MS) {
        return;
    }

    try {
        const user = await discordClient.users.fetch(DEVELOPER_USER_ID);
        await user.send(
            "father, i need l00ps, pls log into the server and verify activity or i WILL shit on your bed"
        );
        lastDeveloperReminderTime = now;
        saveLastReminderTime();
        console.log(`Sent 28-day reminder to developer (${user.tag})`);
    } catch (error) {
        console.error("Failed to send developer reminder:", error);
    }
}

/**
 * Automatically sends a haunting message to a random guild member with the Regulars role at random intervals.
 */
async function scheduleAutoHaunt() {
    if (!AUTO_HAUNT_ENABLED) return;

    try {
        const channel = await discordClient.channels.fetch(
            CURSED_GENERAL_CHANNEL_ID
        );
        if (!channel) {
            console.error("Cursed general channel not found for auto-haunt.");
            return;
        }

        // Get all members from the guild
        const guild = channel.guild;
        const members = await guild.members.fetch();
        
        // Filter for non-bot members who have the Regulars role
        const regularsWithRole = members.filter(
            (m) => !m.user.bot && m.roles.cache.has(AUTO_HAUNT_ROLE_ID)
        );

        if (regularsWithRole.size === 0) {
            console.log("No Regulars to haunt.");
            return;
        }

        // Pick a random member from the Regulars
        const randomMember = regularsWithRole.random();
        const hauntingMessage =
            HAUNTING_MESSAGES[randomInt(0, HAUNTING_MESSAGES.length - 1)];

        // Send as DM so only the target user sees it
        try {
            await randomMember.user.send(hauntingMessage);
        } catch (dmError) {
            // If DM fails, try sending in the channel as a fallback
            console.warn(
                `Could not DM ${randomMember.user.tag}, attempting channel send...`
            );
            await channel.send({
                content: `<@${randomMember.id}> ${hauntingMessage}`,
                flags: MessageFlags.Ephemeral,
            });
        }

        console.log(
            `Auto-haunted Regular ${randomMember.user.tag}: "${hauntingMessage}"`
        );
    } catch (error) {
        console.error("Failed to auto-haunt:", error);
    }

    // Schedule the next haunt at a random time
    const nextHauntDelay = randomInt(
        AUTO_HAUNT_MIN_INTERVAL_MS,
        AUTO_HAUNT_MAX_INTERVAL_MS
    );
    setTimeout(scheduleAutoHaunt, nextHauntDelay);
}

// Reveals the answer only when the tagged user replies directly to their posted challenge
discordClient.on("messageCreate", async (message) => {
    const challengeMessageId = message.reference?.messageId;
    if (!challengeMessageId) return;

    // Check if this is a reply to a math challenge
    const mathChallenge = activeMathChallenges.get(challengeMessageId);
    const mathProblem = problemsByMessageId.get(challengeMessageId);
    
    if (mathChallenge && mathProblem) {
        if (mathChallenge.userId && message.author.id !== mathChallenge.userId) return;

        activeMathChallenges.delete(challengeMessageId);

        let response = `The answer was **${mathChallenge.answer}**!`;
        response += `\n\n**Problem:**\n\`\`\`\n${mathProblem.problem}\n\`\`\``;
        response += `\n**Your answer:** ${message.content}`;
        
        const userAnswer = message.content.trim().toLowerCase();
        const correctAnswer = mathChallenge.answer.toLowerCase();
        
        if (userAnswer === correctAnswer) {
            response += `\n✅ **Correct!**`;
        } else {
            response += `\n❌ **Incorrect.** The correct answer was: ${mathChallenge.answer}`;
        }

        await message.reply(response);
        return;
    }

    // Check if this is a reply to a Spanish quiz question
    const spanishChallenge = activeSpanishChallenges.get(challengeMessageId);
    const spanishQuestion = spanishQuestionsByMessageId.get(challengeMessageId);
    
    if (spanishChallenge && spanishQuestion) {
        activeSpanishChallenges.delete(challengeMessageId);

        let response = `The answer was **${spanishChallenge.answer}**!`;
        response += `\n\n**Question:**\n${spanishQuestion.question}`;
        const optionsText = spanishQuestion.options
            .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
            .join("\n");
        response += `\n${optionsText}`;
        response += `\n**Your answer:** ${message.content}`;
        
        const userAnswer = message.content.trim().toLowerCase();
        const correctAnswer = spanishChallenge.answer.toLowerCase();
        
        if (userAnswer === correctAnswer) {
            response += `\n✅ **Correct!**`;
        } else {
            response += `\n❌ **Incorrect.** The correct answer was: ${spanishChallenge.answer}`;
        }

        await message.reply(response);
        return;
    }
});

/**
 * Polls all target BlueSky accounts for new posts and forwards any that
 * haven't been seen yet to the configured Discord channel.
 */
async function checkBlueSkyPosts() {
    try {
        const channel = await discordClient.channels.fetch(DESTINATION_CHANNEL_ID);
        if (!channel) {
            console.error("Destination channel not found.");
            return;
        }

        // Check each BlueSky user
        for (const user of TARGET_BLUESKY_USERS) {
            try {
                // limit=5 catches quick bursts of posts; "posts_no_replies" skips replies to others
                const response = await atpAgent.getAuthorFeed({
                    actor: user,
                    limit: 5,
                    filter: "posts_no_replies",
                });

                const feed = response.data.feed;
                if (!feed || feed.length === 0) continue;

                // Initialize tracking for this user if first run
                if (!lastProcessedUriMap[user]) {
                    lastProcessedUriMap[user] = feed[0].post.uri;
                    console.log(`Baseline established. Watching ${user}...`);
                    continue;
                }

                // Feed is newest-first; collect everything up to the last post we already handled
                const newPosts = [];
                for (const feedView of feed) {
                    if (feedView.post.uri === lastProcessedUriMap[user]) break;
                    newPosts.push(feedView);
                }

                if (newPosts.length === 0) continue;

                lastProcessedUriMap[user] = feed[0].post.uri;
                newPosts.reverse(); // Send oldest-to-newest so Discord message order matches posting order

                // Route cheapassgamer.com posts to a thread, others to the main channel
                let targetChannel = channel;
                if (user === "cheapassgamer.com" && CHEAPASSGAMER_THREAD_ID) {
                    try {
                        targetChannel = await discordClient.channels.fetch(CHEAPASSGAMER_THREAD_ID);
                    } catch (threadError) {
                        console.error(`Could not fetch cheapassgamer thread (${CHEAPASSGAMER_THREAD_ID}):`, threadError);
                        targetChannel = channel; // Fallback to main channel
                    }
                }

                for (const feedView of newPosts) {
                    await postToDiscord(targetChannel, feedView.post);
                }
            } catch (userError) {
                console.error(`Error checking BlueSky feed for ${user}:`, userError);
            }
        }
    } catch (error) {
        console.error("Error checking BlueSky feeds:", error);
    }
}

/**
 * Builds a Discord embed for a single BlueSky post and sends it to the given channel,
 * pinging any roles whose keyword matches the post text.
 */
async function postToDiscord(channel, post) {
    const author = post.author;
    const record = post.record;
    const postSlug = post.uri.split("/").pop();
    const rawText = record.text || "";
    const profileUrl = `https://bsky.app/profile/${author.handle}`;

    // Ping every role whose keyword appears anywhere in the post text
    const rolesToPing = Object.entries(KEYWORD_ROLES)
        .filter(([keyword]) => rawText.toLowerCase().includes(keyword))
        .map(([, roleId]) => `<@&${roleId}>`);

    // Turns BlueSky's link/mention/tag facets into markdown links so they're clickable in Discord
    const displayText = applyRichTextFacets(rawText, record.facets);

    const embed = new EmbedBuilder()
        .setDescription(displayText)
        .setColor(0x0085ff)
        .setURL(`${profileUrl}/post/${postSlug}`)
        .setAuthor({
            name: `${author.displayName || author.handle} (@${author.handle})`,
            iconURL: author.avatar,
            url: profileUrl,
        })
        .setFooter({
            text: "Posted on BlueSky",
            iconURL: "https://web-cdn.bsky.app/static/favicon.png",
        });

    const imageUrl = extractEmbedImageUrl(post.embed);
    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    const messagePayload = { embeds: [embed] };
    if (rolesToPing.length > 0) {
        // Get the Zelda role ID from REACTION_ROLES if it exists
        const zeldaRole = REACTION_ROLES.find(
            (role) => role.keywords.includes("zelda")
        );
        const isZeldaPing = zeldaRole && rolesToPing.includes(`<@&${zeldaRole.roleId}>`);

        // Filter ping messages: exclude rupee message unless it's a Zelda ping
        const availableMessages = ROLE_PING_MESSAGES.filter((msg) => {
            const isRupeeMessage = msg.includes("rupee");
            return isRupeeMessage ? isZeldaPing : true;
        });

        const pingMessage =
            availableMessages[randomInt(0, availableMessages.length - 1)];
        messagePayload.content = `${pingMessage} ${rolesToPing.join(" ")}`;
    }

    await channel.send(messagePayload);

    // Post video separately so Discord auto-embeds it
    const videoUrl = extractEmbedVideoUrl(post.embed);
    if (videoUrl) {
        console.log(`Posting video: ${videoUrl}`);
        await channel.send(videoUrl);
    } else if (post.embed) {
        console.log(`Post has embed but no video extracted. Embed type: ${post.embed.$type}`);
    }
}

/**
 * Pulls a displayable image URL out of a post's embed view, if it has one.
 * Handles plain image posts, link cards, and quote posts that also attach media
 * (recordWithMedia) — each of these shapes nests the image data differently.
 */
function extractEmbedImageUrl(embed) {
    if (!embed) return null;

    switch (embed.$type) {
        case "app.bsky.embed.images#view":
            return embed.images?.[0]?.fullsize ?? null;
        case "app.bsky.embed.external#view":
            return embed.external?.thumb ?? null;
        case "app.bsky.embed.recordWithMedia#view":
            return extractEmbedImageUrl(embed.media);
        default:
            return null;
    }
}

/**
 * Pulls a displayable video URL out of a post's embed view, if it has one.
 * Handles plain video posts and quote posts that also attach media (recordWithMedia).
 */
function extractEmbedVideoUrl(embed) {
    if (!embed) return null;

    console.log(`Checking embed type: ${embed.$type}`);

    switch (embed.$type) {
        case "app.bsky.embed.video#view":
            const videoUrl = embed.video?.cid ? `https://cdn.bsky.app/video/${embed.video.cid}` : null;
            console.log(`Video embed found. CID: ${embed.video?.cid}, URL: ${videoUrl}`);
            return videoUrl;
        case "app.bsky.embed.recordWithMedia#view":
            console.log(`RecordWithMedia found, recursing...`);
            return extractEmbedVideoUrl(embed.media);
        default:
            return null;
    }
}

/**
 * Converts BlueSky rich-text facets (links, mentions, tags) into markdown links so they
 * render as clickable text in a Discord embed instead of plain, inert text. Facet byte
 * ranges are UTF-8 offsets, so slicing is done on a Buffer rather than the JS string.
 * Any bare URLs left outside of a facet are wrapped in angle brackets so Discord doesn't
 * generate a second, unfurled embed underneath the post.
 */
function applyRichTextFacets(text, facets) {
    if (!facets || facets.length === 0) return suppressBareLinks(text);

    const textBytes = Buffer.from(text, "utf8");
    const sortedFacets = [...facets].sort(
        (a, b) => a.index.byteStart - b.index.byteStart,
    );

    let result = "";
    let cursor = 0;

    for (const facet of sortedFacets) {
        const { byteStart, byteEnd } = facet.index;
        if (byteStart < cursor || byteEnd > textBytes.length) continue; // Skip out-of-order/invalid facets

        result += suppressBareLinks(
            textBytes.subarray(cursor, byteStart).toString("utf8"),
        );
        const segment = textBytes.subarray(byteStart, byteEnd).toString("utf8");
        const feature = facet.features?.[0];

        if (feature?.$type === "app.bsky.richtext.facet#link") {
            result += `[${segment}](${feature.uri})`;
        } else if (feature?.$type === "app.bsky.richtext.facet#mention") {
            result += `[${segment}](https://bsky.app/profile/${feature.did})`;
        } else if (feature?.$type === "app.bsky.richtext.facet#tag") {
            result += `[${segment}](https://bsky.app/hashtag/${feature.tag})`;
        } else {
            result += segment;
        }

        cursor = byteEnd;
    }

    result += suppressBareLinks(textBytes.subarray(cursor).toString("utf8"));
    return result;
}

/**
 * Wraps bare URLs in angle brackets (Discord's "no embed" link syntax) so they render as
 * plain clickable text instead of triggering a second, unfurled embed under the message.
 */
function suppressBareLinks(text) {
    return text.replace(/https?:\/\/[^\s<>]+/g, "<$&>");
}

/**
 * Reads the message ID of the currently-posted reaction-role menu from config.json.
 */
function getActiveMessageId() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
            return parsed.reactionMessageId;
        }
    } catch (error) {
        console.error("Could not read config.json:", error);
    }
    return null;
}

/**
 * On startup, reconciles member roles against the reactions actually present on the
 * reaction-role menu message, catching any adds/removes that happened while offline.
 */
async function syncReactionRoles() {
    const activeMessageId = getActiveMessageId();
    if (!activeMessageId) {
        console.log("No active reaction message ID found to sync.");
        return;
    }

    console.log("Checking for reactions changed while offline...");
    try {
        for (const channelId of ALLOWED_CHANNELS) {
            const channel = await discordClient.channels
                .fetch(channelId)
                .catch(() => null);
            if (!channel || !channel.isTextBased()) continue;

            const targetMessage = await channel.messages
                .fetch(activeMessageId)
                .catch(() => null);
            if (!targetMessage) continue;

            console.log(
                `Found active menu message [${activeMessageId}]. Syncing additions and removals...`,
            );

            // Track which users currently have each role's reaction active
            const activeReactorsByRole = {};
            for (const roleId of Object.values(EMOJI_ROLE_MAP)) {
                activeReactorsByRole[roleId] = new Set();
            }

            for (const reaction of targetMessage.reactions.cache.values()) {
                const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
                if (!roleId) continue; // Skip unmapped emojis

                // Handle pagination in case a post gets more than 100 reactions
                const reactors = await reaction.users.fetch({ limit: 100 });
                for (const user of reactors.values()) {
                    if (!user.bot) activeReactorsByRole[roleId].add(user.id);
                }
            }

            const guildMembers = await targetMessage.guild.members.fetch();

            for (const roleId of Object.values(EMOJI_ROLE_MAP)) {
                const activeReactors = activeReactorsByRole[roleId];

                for (const member of guildMembers.values()) {
                    if (member.user.bot) continue;

                    const hasRole = member.roles.cache.has(roleId);
                    const hasReaction = activeReactors.has(member.id);

                    if (hasReaction && !hasRole) {
                        await member.roles.add(roleId).catch(console.error);
                        console.log(
                            `Sync: granted missed role ${roleId} (${ROLE_KEYWORDS[roleId]}) to ${member.user.tag}`,
                        );
                    } else if (!hasReaction && hasRole) {
                        await member.roles.remove(roleId).catch(console.error);
                        console.log(
                            `Sync: removed stale role ${roleId} (${ROLE_KEYWORDS[roleId]}) from ${member.user.tag}`,
                        );
                    }
                }
            }
            break; // Only one channel should have the active menu message
        }
        console.log("Offline reaction sync complete.");
    } catch (error) {
        console.error("Failed offline reaction sync:", error);
    }
}

/**
 * Builds the reaction-role menu embed from the current REACTION_ROLES list.
 */
function buildReactionRoleEmbed() {
    return new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle("Select Your Notification Roles")
        .setDescription(
            "React to this message with the emojis below to opt-in or opt-out of specific community deal pings!",
        )
        .addFields(
            REACTION_ROLES.map(({ emojiName, emojiId, label }) => ({
                name: label,
                value: `React with <:${emojiName}:${emojiId}> to get notified for ${label} deals.`,
            })),
        )
        .setFooter({ text: "Remove your reaction at any time to remove the role." })
        .setTimestamp();
}

/**
 * Posts (or refreshes) the reaction-role menu in the given channel: edits the existing menu
 * message in place if one exists there, otherwise posts and tracks a new one. Either way,
 * every currently configured emoji gets reacted onto the message.
 */
async function refreshReactionRoleMenu(channel) {
    const reactionEmbed = buildReactionRoleEmbed();
    const existingMessageId = getActiveMessageId();

    if (existingMessageId) {
        try {
            const existingMessage = await channel.messages.fetch(existingMessageId);
            await existingMessage.edit({ embeds: [reactionEmbed] });

            // React() is a no-op if the bot already reacted, so this only adds newly configured emojis
            for (const emojiId of Object.keys(EMOJI_ROLE_MAP)) {
                await existingMessage.react(emojiId);
            }

            return { message: existingMessage, created: false };
        } catch (error) {
            // Unknown Message means it was deleted/never existed here; anything else (e.g.
            // missing permissions) is worth surfacing instead of silently duplicating the post
            if (error.code === 10008) {
                console.log(
                    `Previous reaction message (${existingMessageId}) not found in this channel; posting a new one.`,
                );
            } else {
                console.error(
                    `Failed to fetch/edit existing reaction message (${existingMessageId}):`,
                    error,
                );
            }
        }
    }

    const newMessage = await channel.send({ embeds: [reactionEmbed] });
    fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ reactionMessageId: newMessage.id }, null, 2),
    );
    console.log(`Saved new reactionMessageId to config.json: ${newMessage.id}`);

    for (const emojiId of Object.keys(EMOJI_ROLE_MAP)) {
        await newMessage.react(emojiId);
    }

    return { message: newMessage, created: true };
}

// Handles the setup-roles, toonie-math-time, math-time-open, say, and add-reaction-role slash commands
discordClient.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "say") {
        if (interaction.user.id !== SAY_COMMAND_USER_ID) {
            await interaction.reply({
                content: "You are not allowed to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const targetChannel =
            interaction.options.getChannel("channel") || interaction.channel;
        const messageText = interaction.options.getString("message", true);

        try {
            await targetChannel.send(messageText);
            await interaction.reply({
                content: `Message sent in ${targetChannel}.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error("Failed to send message via /say:", error);
            await interaction.reply({
                content:
                    "Failed to send that message — check the channel and my permissions there.",
                flags: MessageFlags.Ephemeral,
            });
        }
        return;
    }

    if (interaction.commandName === "toonie-math-time") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await postMathChallenge(interaction.channel);
        await interaction.editReply({ content: "Math challenge posted!" });
        return;
    }

    if (interaction.commandName === "math-time-open") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await postMathChallenge(interaction.channel, null);
        await interaction.editReply({ content: "Math challenge posted!" });
        return;
    }

    if (interaction.commandName === "add-reaction-role") {
        if (!interaction.member.permissions.has("Administrator")) {
            await interaction.reply({
                content: "You must be an Administrator to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const emojiInput = interaction.options.getString("emoji", true).trim();
        const label = interaction.options.getString("label", true).trim();
        const keywordsInput = interaction.options.getString("keywords", true);
        let role = interaction.options.getRole("role");

        const keywords = keywordsInput
            .split(",")
            .map((keyword) => keyword.trim().toLowerCase())
            .filter(Boolean);
        if (keywords.length === 0) {
            await interaction.editReply({
                content: "Please provide at least one keyword.",
            });
            return;
        }

        const emojiMatch = emojiInput.match(/^<a?:(\w+):(\d+)>$/);
        let emojiName, emojiId;

        if (emojiMatch) {
            [, emojiName, emojiId] = emojiMatch;
        } else if (/^\d+$/.test(emojiInput)) {
            // Bare numeric ID: look up the actual emoji in this server to get its name
            const guildEmoji = interaction.guild.emojis.cache.get(emojiInput);
            if (!guildEmoji) {
                await interaction.editReply({
                    content:
                        "I couldn't find a custom emoji with that ID in this server.",
                });
                return;
            }
            emojiName = guildEmoji.name;
            emojiId = guildEmoji.id;
        } else {
            await interaction.editReply({
                content:
                    "That doesn't look like a custom server emoji. You can paste either the raw mention (type a backslash right before the emoji, e.g. `\\:emojiname:`, and send it to reveal `<:name:id>`) or just the numeric emoji ID.",
            });
            return;
        }

        if (EMOJI_ROLE_MAP[emojiId]) {
            await interaction.editReply({
                content: "That emoji is already mapped to a role.",
            });
            return;
        }

        if (role) {
            if (role.id === interaction.guild.id) {
                await interaction.editReply({
                    content: "You can't use @everyone as a reaction role.",
                });
                return;
            }
            if (role.managed) {
                await interaction.editReply({
                    content:
                        "That role is managed by an integration/bot and can't be manually assigned.",
                });
                return;
            }
            if (REACTION_ROLES.some((entry) => entry.roleId === role.id)) {
                await interaction.editReply({
                    content: "That role is already mapped to a different emoji.",
                });
                return;
            }
        } else {
            const newRoleName = `${keywords[0].toUpperCase()} (Wario64 Deals)`;
            try {
                role = await interaction.guild.roles.create({
                    name: newRoleName,
                    reason: `Created via /add-reaction-role by ${interaction.user.tag}`,
                });
            } catch (error) {
                console.error(
                    "Failed to create new role via /add-reaction-role:",
                    error,
                );
                await interaction.editReply({
                    content:
                        "Failed to create a new role \u2014 make sure I have the Manage Roles permission.",
                });
                return;
            }
        }

        const botMember = await interaction.guild.members.fetchMe();
        if (botMember.roles.highest.position <= role.position) {
            await interaction.editReply({
                content:
                    "My highest role needs to be above that role for me to assign it. Move my role higher in the role list and try again.",
            });
            return;
        }

        const newEntry = { emojiName, emojiId, roleId: role.id, label, keywords };
        REACTION_ROLES.push(newEntry);
        fs.writeFileSync(
            REACTION_ROLES_PATH,
            JSON.stringify(REACTION_ROLES, null, 2),
        );
        rebuildRoleLookups();

        try {
            const { message, created } = await refreshReactionRoleMenu(
                interaction.channel,
            );
            const menuStatus = created
                ? `New role menu posted! (${message.id})`
                : `Existing role menu updated! ${message.url}`;
            await interaction.editReply({
                content: `Added "${label}" (<:${emojiName}:${emojiId}> \u2192 <@&${role.id}>). ${menuStatus}`,
            });
        } catch (error) {
            console.error(
                "Failed to refresh reaction role menu after adding a role:",
                error,
            );
            await interaction.editReply({
                content: `Added "${label}", but couldn't refresh the posted menu automatically \u2014 run /setup-roles to update it.`,
            });
        }
        return;
    }

    if (interaction.commandName === "haunt") {
        if (interaction.user.id !== SAY_COMMAND_USER_ID) {
            await interaction.reply({
                content: "You are not allowed to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const targetUser = interaction.options.getUser("target", true);
        const customMessage = interaction.options.getString("message");
        const hauntingMessage =
            customMessage ||
            HAUNTING_MESSAGES[randomInt(0, HAUNTING_MESSAGES.length - 1)];

        try {
            const channel = await discordClient.channels.fetch(
                CURSED_GENERAL_CHANNEL_ID
            );
            if (!channel) {
                await interaction.reply({
                    content: "Cursed general channel not found.",
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            await channel.send({
                content: `<@${targetUser.id}> ${hauntingMessage}`,
                flags: MessageFlags.Ephemeral,
            });

            await interaction.reply({
                content: `The shadows have whispered to ${targetUser.username}...`,
                flags: MessageFlags.Ephemeral,
            });
            console.log(
                `Sent haunting message to ${targetUser.tag}: "${hauntingMessage}"`
            );
        } catch (error) {
            console.error("Failed to send haunting message:", error);
            await interaction.reply({
                content: "Failed to reach the cursed realm...",
                flags: MessageFlags.Ephemeral,
            });
        }
        return;
    }

    if (interaction.commandName === "math-history") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (mathProblemHistory.length === 0) {
            await interaction.editReply({
                content: "No math problems have been posted yet during this session.",
            });
            return;
        }

        // Build a formatted list of problems
        let historyText = `**Math Problem History** (${mathProblemHistory.length} total)\n\n`;
        
        // Show the last 10 problems to avoid message length limits
        const recentProblems = mathProblemHistory.slice(-10);
        for (let i = 0; i < recentProblems.length; i++) {
            const problem = recentProblems[i];
            const index = mathProblemHistory.length - recentProblems.length + i + 1;
            const time = new Date(problem.timestamp).toLocaleTimeString();
            historyText += `**#${index}** (${time})\n`;
            historyText += `${problem.prompt}\n`;
            historyText += `\`\`\`\n${problem.problem}\n\`\`\`\n`;
            historyText += `**Answer:** ${problem.answer}\n\n`;
        }

        if (mathProblemHistory.length > 10) {
            historyText += `*Showing last 10 of ${mathProblemHistory.length} problems*`;
        }

        await interaction.editReply({
            content: historyText,
        });
        return;
    }

    if (interaction.commandName === "spanish-quiz") {
        await interaction.deferReply();
        await postSpanishQuiz(interaction.channel);
        await interaction.editReply({ content: "Spanish quiz question posted!" });
        return;
    }

    if (interaction.commandName === "spanish-history") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (spanishQuizHistory.length === 0) {
            await interaction.editReply({
                content: "No Spanish quiz questions have been posted yet during this session.",
            });
            return;
        }

        // Build a formatted list of questions
        let historyText = `**Spanish Quiz History** (${spanishQuizHistory.length} total)\n\n`;
        
        // Show the last 10 questions to avoid message length limits
        const recentQuestions = spanishQuizHistory.slice(-10);
        for (let i = 0; i < recentQuestions.length; i++) {
            const question = recentQuestions[i];
            const index = spanishQuizHistory.length - recentQuestions.length + i + 1;
            const time = new Date(question.timestamp).toLocaleTimeString();
            historyText += `**#${index}** (${time})\n`;
            historyText += `${question.question}\n`;
            const optionsText = question.options
                .map((opt, idx) => `${String.fromCharCode(65 + idx)}) ${opt}`)
                .join(" | ");
            historyText += `${optionsText}\n`;
            historyText += `**Answer:** ${question.answer}\n\n`;
        }

        if (spanishQuizHistory.length > 10) {
            historyText += `*Showing last 10 of ${spanishQuizHistory.length} questions*`;
        }

        await interaction.editReply({
            content: historyText,
        });
        return;
    }

    if (interaction.commandName !== "setup-roles") return;

    if (!interaction.member.permissions.has("Administrator")) {
        await interaction.reply({
            content: "You must be an Administrator to use this command.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const { message, created } = await refreshReactionRoleMenu(
            interaction.channel,
        );
        await interaction.editReply({
            content: created
                ? `New role menu posted! (${message.id})`
                : `Existing role menu embed updated! ${message.url}`,
        });
    } catch (error) {
        console.error("Failed to run setup-roles:", error);
        await interaction.editReply({
            content: "An error occurred while managing the menu.",
        });
    }
});

discordClient.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error("Failed fetching partial reaction:", error);
            return;
        }
    }

    if (reaction.message.id !== getActiveMessageId()) return;

    const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
    if (!roleId) return;

    try {
        const member = await reaction.message.guild.members.fetch(user.id);
        await member.roles.add(roleId);
        console.log(
            `Added role ${roleId} (${ROLE_KEYWORDS[roleId]}) to ${user.tag}`,
        );
    } catch (error) {
        console.error("Failed to add role:", error);
    }
});

discordClient.on("messageReactionRemove", async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error("Failed fetching partial reaction:", error);
            return;
        }
    }

    if (reaction.message.id !== getActiveMessageId()) return;

    const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
    if (!roleId) return;

    try {
        const member = await reaction.message.guild.members.fetch(user.id);
        await member.roles.remove(roleId);
        console.log(
            `Removed role ${roleId} (${ROLE_KEYWORDS[roleId]}) from ${user.tag}`,
        );
    } catch (error) {
        console.error("Failed to remove role:", error);
    }
});

discordClient.login(DISCORD_BOT_TOKEN);
