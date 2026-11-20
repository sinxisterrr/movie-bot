# Movie Night Bot

A restart-safe Discord bot that runs a weekly movie night without routine admin work:

- accepts multiple nominations per member, up to the ballot-wide limit;
- posts a private, changeable ballot;
- randomly resolves ties and reports that it did so;
- announces the winner;
- creates a Discord Scheduled Event for the winning movie;
- pins a self-service button that lets members join or leave the configured notification role;
- advances missed deadlines safely after a restart.

Marvin is also a restart-safe middle manager: administrators can schedule exact-Markdown announcements and native Discord polls in any permitted text or announcement channel, manage the queue, and add custom `/pet` responses without editing code.

Marvin also operates the private Dystopian Event Passport office. Administrators register an event role with its stamp artwork once; receiving that role permanently adds the stamp to the member's ledger. Members can privately render their current passport or any completed volume using their current server avatar and display name. Milestones are delivered by DM, with undeliverable notices held for the member's next `/passport` request.

The weekly rhythm is intentionally simple: nominations open six days before the watch party, voting opens three days before it, and voting closes one day before it.

Running setup opens the current pending cycle immediately, so a newly installed or reconfigured bot can be used at once. Later cycles follow the normal six-day schedule. While a future cycle is pending, `/movie status` shows the exact nomination-opening time.

## Run it

Requirements: Node.js 22.5 or newer (the bot uses Node's built-in SQLite module).

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On its installation page, grant the bot these permissions: View Channels, Send Messages, Send Polls, Read Message History, Create Events, Manage Roles, and Manage Messages. In the Developer Portal's **Bot** page, enable the **Server Members Intent** so Marvin can notice event roles being added, then set `PASSPORT_ROLE_TRACKING=true` in Coolify. The explicit switch prevents a deployment from crashing if the privileged intent has not been enabled yet. Move the bot's role above the Movie Night notification role, and mark that notification role as mentionable so the bot can ping it without the broad Mention Everyone permission.
3. Copy `.env.example` to `.env` and fill in the token, application/client ID, and development server ID.
4. Install and register commands:

   ```powershell
   pnpm install
   pnpm register
   pnpm start
   ```

5. In Discord, run `/movie-admin setup`. Choose the channel, IANA timezone, weekly day and local time, watch location, and optional notification role.

When a notification role is selected, setup creates a pinned welcome post explaining the weekly flow, with explicit **Join Movie Night** and **Leave Movie Night** buttons. The bot only manages the configured role and refuses to operate if that role is above its own role.

For development, `DISCORD_GUILD_ID` registers commands immediately in that server. Remove it before `pnpm register` if you want global commands; global propagation can take longer.

## Commands

- `/pet` — give Marvin a head pat and receive a completely professional response.
- `/treat` — compensate Marvin for his expanding portfolio of responsibilities.
- `/passport volume?` — privately render your current passport or a completed volume. It never accepts another member.
- `/passport-admin event-add role name stamp backfill?` — register or update an event role and its stamp artwork; existing role holders are backfilled by default.
- `/passport-admin event-list` — list active and retired event stamps.
- `/passport-admin event-remove role` — stop new awards without deleting anyone's permanent stamp.
- `/passport-admin grant member role` — manually award a registered stamp for testing or corrections.
- `/movie suggest title` — nominate a movie during the nomination window. Members may suggest multiple distinct movies until the 25-title ballot is full.
- `/movie status` — privately show the phase, date, and nominations.
- `/movie-admin setup` — configure or update the automatic schedule.
- `/movie-admin pause` and `/movie-admin resume` — emergency controls.
- `/manager setup timezone` — set the local timezone used by friendly dates such as `Nov 6 2026 9am`.
- `/manager announce channel when recurring? role?` — open a multiline editor and schedule the exact Markdown body.
- `/manager poll channel when duration recurring? multiple? role?` — schedule a native poll with 2–10 answers.
- `/manager forum channel when recurring? role? attachment-1? attachment-2? attachment-3? attachment-4?` — schedule a forum post with a title, exact Markdown, existing tags, and persistent attachments.
- `/manager list`, `/manager show id`, and `/manager cancel id` — list, privately preview, or cancel pending work.
- `/manager response-add kind`, `/manager response-list kind?`, and `/manager response-remove id` — manage custom `/pet` and `/treat` responses.

For decorated polls, enter one answer per line. Put an emoji before a pipe when desired:

```text
🍄 | Mushrooms
🌲 | The forest
<:marvin:123456789> | Marvin decides
```

Announcements are stored and posted character-for-character, including line breaks and Discord Markdown. An optional selected role is added as a separate first-line mention. Discord's 2,000-character message limit still applies.

Announcements, polls, and forum posts can optionally repeat daily, weekly, monthly, or annually. Recurrence follows the configured managerial timezone and preserves the intended local clock time. Monthly and annual schedules use the last valid day when their anchor date does not exist (for example, January 31 becomes February 28 or 29, then returns to March 31). `/manager list` and `/manager show` identify recurring work; `/manager cancel` ends the entire series. After downtime, Marvin posts a due recurring job once and advances it to the next future occurrence rather than flooding every missed interval.

Forum scheduling opens a modal for the post title, comma-separated existing tag names, and exact opening-post Markdown. Selected attachments are copied immediately into `manager-attachments` beside the SQLite database and survive redeployments through the same persistent volume. One-off attachments are deleted after a successful post; recurring attachments remain until the series is cancelled. The first image becomes Discord's forum/gallery cover. Each scheduled attachment is limited to 20 MB.

Administrative commands require Discord's **Manage Server** permission. The same authorization is checked again when the command is handled.

## Storage and operations

State lives in `data/movie-night.sqlite` by default. Passport stamp artwork is preserved in `data/passport-stamps` by default. Mount/back up the entire `data` directory in Coolify so the ledger and original event art survive redeployments. The scheduler checks once per minute and serially catches up missed phase transitions after downtime. Tokens belong only in `.env`; never commit that file.

Run `pnpm test` for schedule tests and `pnpm run check` for syntax validation.
