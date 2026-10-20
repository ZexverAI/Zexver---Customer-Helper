
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags
} = require("discord.js");

const Fuse = require("fuse.js");
const fs = require("node:fs");
const path = require("node:path");

// ======================================================
// CONFIGURATION
// ======================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const FAQ_CHANNEL_ID = process.env.FAQ_CHANNEL_ID;
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID || "";

const ORANGE = 0xF28C28;
const DATA_DIR = path.join(__dirname, "..", "data");
const FAQ_FILE = path.join(DATA_DIR, "faq.json");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge-base.json");

if (!DISCORD_TOKEN || !GUILD_ID || !FAQ_CHANNEL_ID) {
  console.error(
    "Missing required environment variables: DISCORD_TOKEN, GUILD_ID, FAQ_CHANNEL_ID"
  );
  process.exit(1);
}

// ======================================================
// DISCORD CLIENT
// ======================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Temporary search results, stored separately for each user.
const userSearchResults = new Map();

// ======================================================
// DATA LOADING
// ======================================================

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Data file not found: ${filePath}`);
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && typeof parsed === "object") {
      return Object.values(parsed);
    }

    console.warn(`Expected an array or object in ${filePath}`);
    return [];
  } catch (error) {
    console.error(`Could not read ${filePath}:`, error.message);
    return [];
  }
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === "string");
  }

  if (typeof value === "string" && value.trim()) {
    return [value];
  }

  return [];
}

function normalizeEntry(item, source, index) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const title =
    item.title ||
    item.question ||
    item.name ||
    item.id ||
    `Untitled entry ${index + 1}`;

  const content =
    item.content ||
    item.answer ||
    item.description ||
    "";

  const keywords = asStringArray(item.keywords);
  const aliases = asStringArray(item.aliases);

  if (typeof title !== "string" || typeof content !== "string") {
    return null;
  }

  if (!content.trim()) {
    return null;
  }

  const id = String(item.id || `${source}-${index + 1}`);

  return {
    key: `${source}:${id}`,
    source,
    id,
    title,
    content,
    keywords,
    aliases
  };
}

function loadKnowledge() {
  const faqEntries = readJsonFile(FAQ_FILE)
    .map((item, index) => normalizeEntry(item, "faq", index))
    .filter(Boolean);

  const knowledgeEntries = readJsonFile(KNOWLEDGE_FILE)
    .map((item, index) => normalizeEntry(item, "knowledge", index))
    .filter(Boolean);

  const allEntries = [...faqEntries, ...knowledgeEntries];

  console.log(
    `Loaded ${faqEntries.length} FAQ entries and ` +
    `${knowledgeEntries.length} knowledge base entries.`
  );

  return allEntries;
}

let knowledgeEntries = loadKnowledge();

// ======================================================
// SEARCH ENGINE
// Searches titles, content, keywords and aliases.
// ======================================================

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from(
    { length: b.length + 1 },
    (_, index) => index
  );

  for (let i = 1; i <= a.length; i++) {
    const current = [i];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }

    previous = current;
  }

  return previous[b.length];
}

function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Small words need a stricter comparison to avoid false matches.
  const distance = levenshtein(a, b);
  const longest = Math.max(a.length, b.length);

  if (longest <= 2) {
    return distance === 1 ? 0.5 : 0;
  }

  return 1 - distance / longest;
}

function calculateTokenScore(query, entry) {
  const queryTokens = normalizeText(query)
    .split(" ")
    .filter(Boolean);

  if (!queryTokens.length) return 0;

  const titleTokens = normalizeText(entry.title).split(" ");
  const aliasTokens = normalizeText(entry.aliases.join(" ")).split(" ");
  const keywordTokens = normalizeText(entry.keywords.join(" ")).split(" ");
  const contentTokens = normalizeText(entry.content).split(" ");

  // Titles, aliases and keywords are more important than body text.
  const groups = [
    { tokens: titleTokens, weight: 1.0 },
    { tokens: aliasTokens, weight: 0.95 },
    { tokens: keywordTokens, weight: 0.9 },
    { tokens: contentTokens, weight: 0.7 }
  ];

  let total = 0;

  for (const queryToken of queryTokens) {
    let bestMatch = 0;

    for (const group of groups) {
      let groupMatch = 0;

      for (const token of group.tokens) {
        groupMatch = Math.max(
          groupMatch,
          wordSimilarity(queryToken, token)
        );
      }

      bestMatch = Math.max(
        bestMatch,
        groupMatch * group.weight
      );
    }

    total += bestMatch;
  }

  return total / queryTokens.length;
}

function searchKnowledge(query) {
  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery || !knowledgeEntries.length) {
    return [];
  }

  const fuse = new Fuse(knowledgeEntries, {
    keys: [
      { name: "title", weight: 3 },
      { name: "aliases", weight: 2.5 },
      { name: "keywords", weight: 2 },
      { name: "content", weight: 1 }
    ],
    includeScore: true,
    threshold: 0.65,
    ignoreLocation: true,
    findAllMatches: true,
    minMatchCharLength: 1
  });

  const fuseResults = fuse.search(normalizedQuery);
  const fuseScores = new Map(
    fuseResults.map(result => [
      result.item.key,
      1 - (result.score ?? 1)
    ])
  );

  const ranked = knowledgeEntries.map(entry => {
    const fuseScore = fuseScores.get(entry.key) || 0;
    const tokenScore = calculateTokenScore(query, entry);

    const normalizedTitle = normalizeText(entry.title);
    const normalizedAliases = normalizeText(entry.aliases.join(" "));
    const normalizedKeywords = normalizeText(entry.keywords.join(" "));

    let exactBonus = 0;

    if (normalizedTitle.includes(normalizedQuery)) {
      exactBonus = 0.2;
    } else if (
      normalizedAliases.includes(normalizedQuery) ||
      normalizedKeywords.includes(normalizedQuery)
    ) {
      exactBonus = 0.15;
    }

    const score = Math.min(
      1,
      Math.max(fuseScore, tokenScore * 0.85) + exactBonus
    );

    return { ...entry, score };
  });

  return ranked
    .filter(entry => entry.score >= 0.30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ======================================================
// PRIVATE SUPPORT FOOTER
// ======================================================

function getSupportText() {
  const supportTarget = SUPPORT_CHANNEL_ID
    ? `<#${SUPPORT_CHANNEL_ID}>`
    : "#support";

  return (
    "Still need help? If this isn't what you're looking for, " +
    `try rephrasing your question or visit ${supportTarget} ` +
    "for further assistance!"
  );
}

// ======================================================
// FAQ PANEL
// The panel is public. Search results are private.
// ======================================================

function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle("ZexverAI Help Center")
    .setDescription(
      "Need help with ZexverAI?\n\n" +
      "Select **Search FAQ** below and enter your question. " +
      "The search checks the FAQ and the knowledge base, " +
      "including common spelling mistakes.\n\n" +
      "Your search results and answers are private."
    )
    .setFooter({ text: "ZexverAI Customer Helper" });

  const button = new ButtonBuilder()
    .setCustomId("faq:open")
    .setLabel("Search FAQ")
    .setStyle(ButtonStyle.Primary)
    .setEmoji("🔎");

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)]
  };
}

async function getFaqChannel() {
  const channel = await client.channels.fetch(FAQ_CHANNEL_ID);

  if (
    !channel ||
    !channel.isTextBased() ||
    typeof channel.send !== "function" ||
    !channel.messages
  ) {
    throw new Error(
      "FAQ_CHANNEL_ID must point to a text channel where the bot can send messages."
    );
  }

  return channel;
}

async function publishPanel() {
  const channel = await getFaqChannel();
  const messages = await channel.messages.fetch({ limit: 50 });

  const existingPanel = messages.find(message =>
    message.author.id === client.user.id &&
    message.embeds.some(embed => embed.title === "ZexverAI Help Center")
  );

  if (existingPanel) {
    await existingPanel.edit(buildPanel());
    console.log("Updated the existing FAQ panel.");
  } else {
    await channel.send(buildPanel());
    console.log("Published the FAQ panel.");
  }
}

// ======================================================
// MODAL
// ======================================================

function buildSearchModal() {
  const modal = new ModalBuilder()
    .setCustomId("faq:search")
    .setTitle("Search ZexverAI Help");

  const questionInput = new TextInputBuilder()
    .setCustomId("faq:question")
    .setLabel("What do you need help with?")
    .setPlaceholder("Example: How do I use ZexverAI?")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(200)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(questionInput)
  );

  return modal;
}

// ======================================================
// SEARCH RESULTS
// These are returned as private interaction responses.
// ======================================================

function buildResultsMessage(results) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("faq:pick")
    .setPlaceholder("Select the most relevant result")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      results.slice(0, 25).map(entry => ({
        label: entry.title.slice(0, 100),
        description: (
          `${entry.source === "faq" ? "FAQ" : "Knowledge Base"} • ` +
          entry.content.replace(/\s+/g, " ").slice(0, 75)
        ).slice(0, 100),
        value: entry.key
      }))
    );

  const embed = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle("Search Results")
    .setDescription(
      "Choose the result that best matches your question. " +
      "Only you can see these results."
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select)
    ],
    flags: MessageFlags.Ephemeral
  };
}

function buildNoResultsMessage() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(ORANGE)
        .setTitle("No Matching Results")
        .setDescription(
          "I couldn't find a sufficiently close match. " +
          "Try using different words or a more specific question."
        )
    ],
    content: getSupportText(),
    flags: MessageFlags.Ephemeral
  };
}

// ======================================================
// PRIVATE ANSWER
// ======================================================

function buildAnswerMessage(entry) {
  const sourceLabel =
    entry.source === "faq" ? "Frequently Asked Question" : "Knowledge Base";

  const answer = new EmbedBuilder()
    .setColor(ORANGE)
    .setTitle(entry.title.slice(0, 256))
    .setDescription(entry.content.slice(0, 4000))
    .setFooter({ text: sourceLabel });

  return {
    embeds: [answer],
    content: getSupportText(),
    components: [],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  };
}

// ======================================================
// SLASH COMMAND
// ======================================================

const setupCommand = new SlashCommandBuilder()
  .setName("setup-faq")
  .setDescription("Publish or update the public ZexverAI help panel.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// ======================================================
// INTERACTIONS
// ======================================================

client.on(Events.InteractionCreate, async interaction => {
  try {
    // ----------------------------------------------
    // /setup-faq
    // ----------------------------------------------

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "setup-faq") return;

      if (!interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      )) {
        await interaction.reply({
          content: "Only server administrators can use this command.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      try {
        await publishPanel();

        await interaction.editReply(
          "The ZexverAI Help Center panel has been published or updated."
        );
      } catch (error) {
        console.error("Could not publish FAQ panel:", error);

        await interaction.editReply(
          "I couldn't publish the panel. Check the FAQ channel ID and the bot's channel permissions."
        );
      }

      return;
    }

    // ----------------------------------------------
    // Search button: open the modal
    // ----------------------------------------------

    if (
      interaction.isButton() &&
      interaction.customId === "faq:open"
    ) {
      await interaction.showModal(buildSearchModal());
      return;
    }

    // ----------------------------------------------
    // Modal submitted: search both data files
    // ----------------------------------------------

    if (
      interaction.isModalSubmit() &&
      interaction.customId === "faq:search"
    ) {
      const question = interaction.fields
        .getTextInputValue("faq:question")
        .trim();

      if (question.length < 2) {
        await interaction.reply({
          content: "Please enter a longer question.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // Reload files so changes can be picked up after restart or
      // a new search, without editing the source code.
      knowledgeEntries = loadKnowledge();

      const results = searchKnowledge(question);

      if (!results.length) {
        await interaction.reply(buildNoResultsMessage());
        return;
      }

      userSearchResults.set(interaction.user.id, {
        results,
        createdAt: Date.now()
      });

      await interaction.reply(buildResultsMessage(results));
      return;
    }

    // ----------------------------------------------
    // User selects a result
    // ----------------------------------------------

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "faq:pick"
    ) {
      const saved = userSearchResults.get(interaction.user.id);

      // A select menu message should already be private.
      // This check also prevents a different user from using
      // another user's stored search results.
      if (!saved) {
        await interaction.reply({
          content: "Your search has expired. Please search again.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const age = Date.now() - saved.createdAt;

      if (age > 15 * 60 * 1000) {
        userSearchResults.delete(interaction.user.id);

        await interaction.reply({
          content: "Your search has expired. Please search again.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const selectedKey = interaction.values[0];

      const entry = saved.results.find(
        result => result.key === selectedKey
      );

      if (!entry) {
        await interaction.reply({
          content: "That result is no longer available. Please search again.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      // Update the original ephemeral search message with the answer.
      // No public channel message is sent here.
      await interaction.update(buildAnswerMessage(entry));
      return;
    }
  } catch (error) {
    console.error("Interaction error:", error);

    const errorMessage =
      "Something went wrong while processing your request. Please try again.";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: errorMessage,
          flags: MessageFlags.Ephemeral
        });
      } else {
        await interaction.reply({
          content: errorMessage,
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (replyError) {
      console.error("Could not send error response:", replyError.message);
    }
  }
});

// ======================================================
// STARTUP
// ======================================================

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await readyClient.application.commands.set(
      [setupCommand.toJSON()],
      GUILD_ID
    );

    console.log("Registered /setup-faq for the configured server.");
  } catch (error) {
    console.error("Could not register slash commands:", error);
  }

  console.log(
    `Search database ready: ${knowledgeEntries.length} total entries.`
  );
});

client.on(Events.Error, error => {
  console.error("Discord client error:", error);
});

client.login(DISCORD_TOKEN);
