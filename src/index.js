import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { openDatabase } from './database.js';
import { MovieNight } from './movie-night.js';
import { Manager } from './manager.js';
import { Passport } from './passport.js';

if (!process.env.DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env.');
const db = openDatabase(process.env.DATABASE_PATH ?? './data/movie-night.sqlite');
const passportRoleTracking = process.env.PASSPORT_ROLE_TRACKING === 'true';
const intents = [GatewayIntentBits.Guilds];
if (passportRoleTracking) intents.push(GatewayIntentBits.GuildMembers);
const client = new Client({ intents });
const movieNight = new MovieNight(client, db);
const manager = new Manager(client, db);
const passport = new Passport(client, db);

client.once(Events.ClientReady, async (ready) => {
  console.log(`Ready as ${ready.user.tag}`);
  if (!passportRoleTracking) console.warn('Passport automatic role tracking is off. Set PASSPORT_ROLE_TRACKING=true after enabling Server Members Intent.');
  await movieNight.tick();
  await manager.tick();
  setInterval(() => movieNight.tick(), 60_000).unref();
  setInterval(() => manager.tick(), 10_000).unref();
});
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'manager') await manager.handle(interaction);
    else if (interaction.isChatInputCommand() && ['passport', 'passport-admin'].includes(interaction.commandName)) await passport.handle(interaction);
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
client.on(Events.GuildMemberUpdate, async (before, after) => {
  try {
    await passport.handleMemberUpdate(before, after);
  } catch (error) {
    console.error('Passport role-award error', error);
  }
});
client.login(process.env.DISCORD_TOKEN);
