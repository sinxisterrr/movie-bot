import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { openDatabase } from './database.js';
import { MovieNight } from './movie-night.js';
import { Manager } from './manager.js';

if (!process.env.DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env.');
const db = openDatabase(process.env.DATABASE_PATH ?? './data/movie-night.sqlite');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const movieNight = new MovieNight(client, db);
const manager = new Manager(client, db);

client.once(Events.ClientReady, async (ready) => {
  console.log(`Ready as ${ready.user.tag}`);
  await movieNight.tick();
  await manager.tick();
  setInterval(() => movieNight.tick(), 60_000).unref();
  setInterval(() => manager.tick(), 10_000).unref();
});
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'manager') await manager.handle(interaction);
    else if (interaction.isModalSubmit() && interaction.customId.startsWith('manager:')) await manager.handleModal(interaction);
    else if (interaction.isChatInputCommand()) await movieNight.handle(interaction);
    else if (interaction.isMessageComponent()) await movieNight.handleComponent(interaction);
  } catch (error) {
    console.error('Unhandled interaction error', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Marvin dropped the paperwork. Please try again.', ephemeral: true }).catch(() => {});
    }
  }
});
client.login(process.env.DISCORD_TOKEN);
