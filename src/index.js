import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { openDatabase } from './database.js';
import { MovieNight } from './movie-night.js';

if (!process.env.DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env.');
const db = openDatabase(process.env.DATABASE_PATH ?? './data/movie-night.sqlite');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const movieNight = new MovieNight(client, db);

client.once(Events.ClientReady, async (ready) => {
  console.log(`Ready as ${ready.user.tag}`);
  await movieNight.tick();
  setInterval(() => movieNight.tick(), 60_000).unref();
});
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) await movieNight.handle(interaction);
  else if (interaction.isMessageComponent()) await movieNight.handleComponent(interaction);
});
client.login(process.env.DISCORD_TOKEN);
