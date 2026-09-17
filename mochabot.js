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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== CONFIGURATION ====================

// Discord credentials/targets
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DESTINATION_CHANNEL_ID = process.env.DESTINATION_CHANNEL_ID; // Where BlueSky cross-posts are sent

// BlueSky login used to read the feed (needs an app password, not the main account password)
const BLUESKY_HANDLE = process.env.BLUESKY_HANDLE;
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD;

// The BlueSky account whose posts get mirrored to Discord
const TARGET_BLUESKY_USER = process.env.TARGET_BLUESKY_USER;

// How often to poll BlueSky for new posts, in milliseconds
const POLL_INTERVAL_MS = 60000;

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
    "u can buy a Hole meal with these savings",
    "synnie drugs me to keep me working"
];

// Only this user may run /say
const SAY_COMMAND_USER_ID = "116938174823006209";

// Developer reminder settings: ping the developer every 28 days
const DEVELOPER_USER_ID = process.env.DEVELOPER_USER_ID || SAY_COMMAND_USER_ID;
const DEVELOPER_REMINDER_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

// Chat keyword monitor settings
const ALLOWED_CHANNELS = ["121721532551528448", "1548135439829835906"];

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
const MATH_QUIZ_INTERVAL_MS = 60 * 60 * 1000;

// Guild the slash commands (/setup-roles, /toonie-math-time) are scoped to, instead of registering them globally
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID;

// Persists the ID of the posted reaction-role menu message across restarts
const CONFIG_PATH = path.join(__dirname, "config.json");
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

// URI of the most recently posted item, used to detect new posts and avoid duplicates
let lastProcessedUri = null;

// Posted math challenges awaiting a reply: message ID -> { answer, userId }
const activeMathChallenges = new Map();

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
        setInterval(checkBlueSkyPosts, POLL_INTERVAL_MS);
        await checkBlueSkyPosts(); // Run once immediately instead of waiting for the first interval
    } catch (error) {
        console.error("Failed to login to BlueSky:", error);
    }

    setInterval(postScheduledMathChallenge, MATH_QUIZ_INTERVAL_MS);

    setInterval(sendDeveloperReminder, DEVELOPER_REMINDER_INTERVAL_MS);

    await syncReactionRoles();
});

/**
 * Picks a random equation type so challenges alternate between a "solve for x"
 * quadratic and a "solve for x and y" system of equations.
 */
function generateAlgebraEquation() {
    return Math.random() < 0.5
        ? generateFoilEquation()
        : generateSystemEquation();
}

/**
 * Builds a quadratic by FOILing two binomials, (x + p)(x + q), expanded to
 * x^2 + bx + c = 0. The two binomial roots (-p and -q) are the solutions for x.
 */
function generateFoilEquation() {
    const p = randomNonZeroInt(-9, 9);
    const q = randomNonZeroInt(-9, 9);

    const b = p + q; // Outer + Inner terms
    const c = p * q; // First * Last term

    const bTerm = b === 0 ? "" : b > 0 ? ` + ${b}x` : ` - ${Math.abs(b)}x`;
    const cTerm = c === 0 ? "" : c > 0 ? ` + ${c}` : ` - ${Math.abs(c)}`;

    const roots = [...new Set([-p, -q])].sort((first, second) => first - second);
    const answer = roots.map((root) => `x = ${root}`).join(" or ");

    return {
        equation: `x^2${bTerm}${cTerm} = 0`,
        answer,
        prompt: "Solve for x:",
    };
}

/**
 * Builds a system of two linear equations in x and y with a single unique integer solution.
 */
function generateSystemEquation() {
    const x = randomInt(-8, 8);
    const y = randomInt(-8, 8);

    let a1, b1, a2, b2;
    do {
        a1 = randomNonZeroInt(-6, 6);
        b1 = randomNonZeroInt(-6, 6);
        a2 = randomNonZeroInt(-6, 6);
        b2 = randomNonZeroInt(-6, 6);
    } while (a1 * b2 - a2 * b1 === 0); // Reject coefficients with no unique solution

    const c1 = a1 * x + b1 * y;
    const c2 = a2 * x + b2 * y;

    const line1 = `${a1}x ${b1 >= 0 ? "+" : "-"} ${Math.abs(b1)}y = ${c1}`;
    const line2 = `${a2}x ${b2 >= 0 ? "+" : "-"} ${Math.abs(b2)}y = ${c2}`;

    return {
        equation: `${line1}
${line2}`,
        answer: `x = ${x}, y = ${y}`,
        prompt: "Solve for x and y:",
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
 * Sends a 28-day reminder to the developer via DM.
 */
async function sendDeveloperReminder() {
    try {
        const user = await discordClient.users.fetch(DEVELOPER_USER_ID);
        await user.send(
            "father, i need l00ps, pls log into the server and verify activity or i WILL shit on your bed"
        );
        console.log(`Sent 28-day reminder to developer (${user.tag})`);
    } catch (error) {
        console.error("Failed to send developer reminder:", error);
    }
}

// Reveals the answer only when the tagged user replies directly to their posted challenge
discordClient.on("messageCreate", async (message) => {
    const challengeMessageId = message.reference?.messageId;
    if (!challengeMessageId) return;

    const challenge = activeMathChallenges.get(challengeMessageId);
    if (!challenge) return;
    if (challenge.userId && message.author.id !== challenge.userId) return; // Untagged challenges are open to anyone

    activeMathChallenges.delete(challengeMessageId);
    await message.reply(`The answer was ${challenge.answer}!`);
});

/**
 * Polls the target BlueSky account for new posts and forwards any that
 * haven't been seen yet to the configured Discord channel.
 */
async function checkBlueSkyPosts() {
    try {
        const channel = await discordClient.channels.fetch(DESTINATION_CHANNEL_ID);
        if (!channel) {
            console.error("Destination channel not found.");
            return;
        }

        // limit=5 catches quick bursts of posts; "posts_no_replies" skips replies to others
        const response = await atpAgent.getAuthorFeed({
            actor: TARGET_BLUESKY_USER,
            limit: 5,
            filter: "posts_no_replies",
        });

        const feed = response.data.feed;
        if (!feed || feed.length === 0) return;

        // First run: just record the current newest post so we don't spam old content
        if (lastProcessedUri === null) {
            lastProcessedUri = feed[0].post.uri;
            console.log(`Baseline established. Watching ${TARGET_BLUESKY_USER}...`);
            return;
        }

        // Feed is newest-first; collect everything up to the last post we already handled
        const newPosts = [];
        for (const feedView of feed) {
            if (feedView.post.uri === lastProcessedUri) break;
            newPosts.push(feedView);
        }

        if (newPosts.length === 0) return;

        lastProcessedUri = feed[0].post.uri;
        newPosts.reverse(); // Send oldest-to-newest so Discord message order matches posting order

        for (const feedView of newPosts) {
            await postToDiscord(channel, feedView.post);
        }
    } catch (error) {
        console.error("Error checking BlueSky feed:", error);
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
        const pingMessage =
            ROLE_PING_MESSAGES[randomInt(0, ROLE_PING_MESSAGES.length - 1)];
        messagePayload.content = `${pingMessage} ${rolesToPing.join(" ")}`;
    }

    await channel.send(messagePayload);

    // Post video separately so Discord auto-embeds it
    const videoUrl = extractEmbedVideoUrl(post.embed);
    if (videoUrl) {
        await channel.send(videoUrl);
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

    switch (embed.$type) {
        case "app.bsky.embed.video#view":
            return embed.video?.cid ? `https://cdn.bsky.app/video/${embed.video.cid}` : null;
        case "app.bsky.embed.recordWithMedia#view":
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
