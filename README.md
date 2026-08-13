# Movie Night Bot

A restart-safe Discord bot that runs a weekly movie night without routine admin work:

- opens one nomination per member;
- posts a private, changeable ballot;
- randomly resolves ties and reports that it did so;
- announces the winner;
- creates a Discord Scheduled Event for the winning movie;
- advances missed deadlines safely after a restart.

The weekly rhythm is intentionally simple: nominations open six days before the watch party, voting opens three days before it, and voting closes one day before it.

## Run it

Requirements: Node.js 22.5 or newer (the bot uses Node's built-in SQLite module).

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On its installation page, grant the bot these permissions: View Channels, Send Messages, Read Message History, Mention Everyone (only if it will ping a role), and Create Events.
3. Copy `.env.example` to `.env` and fill in the token, application/client ID, and development server ID.
4. Install and register commands:

   ```powershell
   pnpm install
   pnpm register
   pnpm start
   ```

5. In Discord, run `/movie-admin setup`. Choose the channel, IANA timezone, weekly day and local time, watch location, and optional notification role.

For development, `DISCORD_GUILD_ID` registers commands immediately in that server. Remove it before `pnpm register` if you want global commands; global propagation can take longer.

## Commands

- `/movie suggest title` — nominate one movie during the nomination window.
- `/movie status` — privately show the phase, date, and nominations.
- `/movie-admin setup` — configure or update the automatic schedule.
- `/movie-admin pause` and `/movie-admin resume` — emergency controls.

Administrative commands require Discord's **Manage Server** permission. The same authorization is checked again when the command is handled.

## Storage and operations

State lives in `data/movie-night.sqlite` by default. Back up that file to preserve configuration, nominations, votes, and event receipts. The scheduler checks once per minute and serially catches up missed phase transitions after downtime. Tokens belong only in `.env`; never commit that file.

Run `pnpm test` for schedule tests and `pnpm run check` for syntax validation.
