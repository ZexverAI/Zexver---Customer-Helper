const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require("discord.js");

const Fuse = require("fuse.js");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const FAQ_CHANNEL_ID = process.env.FAQ_CHANNEL_ID;
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID;

if (!TOKEN || !GUILD_ID || !FAQ_CHANNEL_ID) {
  console.error(
    "Missing environment variables: DISCORD_TOKEN, GUILD_ID, FAQ_CHANNEL_ID"
  );
  process.exit(1);
}

const FAQ_PATH = path.join(__dirname, "..", "data", "faq.json");

function loadFaq() {
  const parsed = JSON.parse(fs.readFileSync(FAQ_PATH, "utf8"));

  if (!Array.isArray(parsed)) {
    throw new Error("data/faq.json must contain an array.");
  }

  for (const entry of parsed) {
    if (
      !entry.id ||
      !entry.question ||
      !entry.answer ||
      !Array.isArray(entry.aliases) ||
      !Array.isArray(entry.keywords)
    ) {
      throw new Error(`Invalid FAQ entry: ${entry.id || "unknown"}`);
    }
  }

  return parsed;
}

const faq = loadFaq();

const fuse = new Fuse(faq, {
  keys: [
    { name: "question", weight: 0.55 },
    { name: "aliases", weight: 0.30 },
    { name: "keywords", weight: 0.15 }
  ],
  includeScore: true,
  threshold: 0.65,
  ignoreLocation: true,
  minMatchCharLength: 2
});

function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const previous = Array.from(
    { length: b.length + 1 },
    (_, i) => i
  );

  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const old = previous[j];

      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );

      diagonal = old;
    }
  }

  return previous[b.length];
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function scoreText(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);

  if (!q || !c) return 0;
  if (q === c) return 1;

  const qTokens = q.split(" ");
  const cTokens = c.split(" ");

  // Match each query word to its closest candidate word.
  const tokenScores = qTokens.map((word) => {
    return Math.max(
      0,
      ...cTokens.map((candidateWord) =>
        similarity(word, candidateWord)
      )
    );
  });

  const tokenAverage =
    tokenScores.reduce((sum, value) => sum + value, 0) /
    tokenScores.length;

  // Also compare the query with the beginning of the candidate.
  const candidateBeginning = cTokens
    .slice(0, qTokens.length)
    .join(" ");

  const phraseScore = similarity(q, candidateBeginning) * 0.92;

  let score = Math.max(tokenAverage, phraseScore);

  // A short phrase such as "Hoe Ti" can still match "How to".
  if (
    qTokens.length >= 2 &&
    tokenScores.every((value) => value >= 0.4)
  ) {
    score += 0.04;
  }

  return Math.min(1, score);
}

function searchFaq(query) {
  const normalizedQuery = normalize(query);

  if (normalizedQuery.length < 2) return [];

  const fuzzyResults = fuse.search(query);
  const fuzzyScores = new Map(
    fuzzyResults.map((result) => [
      result.item.id,
      1 - (result.score ?? 1)
    ])
  );

  const ranked = faq.map((entry) => {
    const candidates = [
      entry.question,
      ...entry.aliases,
      ...entry.keywords
    ];

    const typoScore = Math.max(
      ...candidates.map((candidate) =>
        scoreText(query, candidate)
      )
    );

    const fuseScore = fuzzyScores.get(entry.id) ?? 0;

    return {
      entry,
      score: Math.max(typoScore, fuseScore * 0.7)
    };
  });

  return ranked
    .filter((result) => result.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((result) => result.entry);
}

function getSupportText() {
  const support = SUPPORT_CHANNEL_ID
    ? `<#${SUPPORT_CHANNEL_ID}>`
    : "#support";

  return (
    "Still need help? If this isn't what you're looking for, " +
    `try rephrasing your question or visit ${support} ` +
    "for further assistance!"
  );
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xF28C28)
    .setTitle("Zexver - Customer Helper")
    .setDescription(
      "Welcome to the ZexverAI FAQ Support Center!\n\n" +
      "Click **Search FAQ** to find answers about ZexverAI. " +
      "You can enter a question even if you are unsure of the exact wording."
    )
    .addFields({
      name: "How it works",
      value:
        "1. Click **Search FAQ**.\n" +
        "2. Enter your question.\n" +
        "3. Choose the closest matching question.\n" +
        "4. Read the answer posted by the bot."
    })
    .setFooter({ text: "Official ZexverAI Support" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("faq:open")
      .setLabel("Search FAQ")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

async function getFaqChannel(client) {
  const channel = await client.channels.fetch(FAQ_CHANNEL_ID);

  if (!channel || !channel.isTextBased() || !channel.send) {
    throw new Error("FAQ_CHANNEL_ID is not a usable text channel.");
  }

  return channel;
}

async function publishPanel(client) {
  const channel = await getFaqChannel(client);

  const messages = await channel.messages.fetch({ limit: 50 });

  const existingPanel = messages.find((message) => {
    if (message.author.id !== client.user.id) return false;

    return message.components.some((row) =>
      row.components.some(
        (component) => component.customId === "faq:open"
      )
    );
  });

  const panel = buildPanel();

  if (existingPanel) {
    await existingPanel.edit(panel);
    return "Updated the existing FAQ panel.";
  }

  await channel.send(panel);
  return "Published the FAQ panel.";
}

const setupCommand = new SlashCommandBuilder()
  .setName("setup-faq")
  .setDescription("Create or update the FAQ support panel.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Loaded ${faq.length} FAQ entries.`);

  try {
    await readyClient.application.commands.set(
      [setupCommand.toJSON()],
      GUILD_ID
    );

    console.log("Registered /setup-faq for the configured server.");
  } catch (error) {
    console.error("Could not register the slash command:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Keep the bot restricted to the configured official server.
    if (interaction.guildId !== GUILD_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "This bot is only available on the official ZexverAI server.",
          ephemeral: true
        });
      }

      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "setup-faq") return;

      if (
        !interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator
        )
      ) {
        await interaction.reply({
          content: "Only server administrators can run this command.",
          ephemeral: true
        });
        return;
      }

      const message = await publishPanel(client);

      await interaction.reply({
        content: message,
        ephemeral: true
      });

      return;
    }

    if (interaction.isButton() && interaction.customId === "faq:open") {
      const modal = new ModalBuilder()
        .setCustomId("faq:search")
        .setTitle("Search ZexverAI FAQ");

      const questionInput = new TextInputBuilder()
        .setCustomId("faq_query")
        .setLabel("What do you need help with?")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Example: Hoe Ti")
        .setMinLength(2)
        .setMaxLength(200)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(questionInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === "faq:search"
    ) {
      const query = interaction.fields
        .getTextInputValue("faq_query")
        .trim();

      const results = searchFaq(query);

      if (results.length === 0) {
        await interaction.reply({
          content:
            "I couldn't find a sufficiently close FAQ match. " +
            "Try rephrasing your question or contact support.\n\n" +
            getSupportText(),
          ephemeral: true
        });

        return;
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(`faq:pick:${interaction.user.id}`)
        .setPlaceholder("Choose the question that matches your problem")
        .addOptions(
          results.map((entry) => ({
            label: entry.question.slice(0, 100),
            description: entry.answer.slice(0, 100),
            value: entry.id
          }))
        );

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.reply({
        content:
          `Search results for **${query}**. ` +
          "Choose the closest matching question:",
        components: [row],
        ephemeral: true
      });

      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("faq:pick:")
    ) {
      const expectedUserId = interaction.customId.split(":")[2];

      if (interaction.user.id !== expectedUserId) {
        await interaction.reply({
          content: "These search results belong to another user. Please search again.",
          ephemeral: true
        });
        return;
      }

      const selectedId = interaction.values[0];
      const entry = faq.find((item) => item.id === selectedId);

      if (!entry) {
        await interaction.reply({
          content: "That FAQ entry is no longer available. Please search again.",
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const channel = await getFaqChannel(client);

      const embed = new EmbedBuilder()
        .setColor(0xF28C28)
        .setTitle(entry.question.slice(0, 256))
        .setDescription(entry.answer.slice(0, 4000))
        .setFooter({
          text: "Zexver - Customer Helper | Official ZexverAI Support"
        });

      await channel.send({
        content: getSupportText(),
        embeds: [embed],
        allowedMentions: { parse: [] }
      });

      await interaction.editReply({
        content: "Your FAQ answer has been posted in the support channel."
      });
    }
  } catch (error) {
    console.error("Interaction error:", error);

    const message =
      "Something went wrong while processing your request. Please try again.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message }).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.login(TOKEN).catch((error) => {
  console.error("Could not log in to Discord. Check DISCORD_TOKEN.");
  console.error(error.message);
});

